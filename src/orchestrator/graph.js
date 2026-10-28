'use strict';
const { randomUUID } = require('crypto');
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');

const kubectl              = require('../tools/kubectl');
const { verifyResourceHealthy, isPodHealthy } = require('../tools/podHealth');
const WorkflowTracer       = require('../monitoring/workflowTracer');
const { IncidentTracer, resourceFromIssue } = require('../monitoring/incidentTracer');
const liveWorkflowStore    = require('../monitoring/liveWorkflowStore');
const workflowTraceStore   = require('../api/workflowTraceStore');
const tokenStore           = require('../api/tokenStore');
const fastPath             = require('../agents/fastPath');
const investigator         = require('../agents/investigator');
const planner               = require('../agents/planner');
const GuardianAgent        = require('../agents/guardianAgent');
const ReflectionAgent      = require('../agents/reflectionAgent');
const { assessRootCauseFit } = require('../agents/rootCauseFitAssessor');
const executor             = require('../agents/executor');
const PolicyEngine         = require('../policy/policyEngine');
const episodicMemory       = require('../memory/episodicMemory');
const ruleEngine           = require('../memory/ruleEngine');
const approvalStore        = require('../api/approvalStore');
const escalationStore      = require('../api/escalationStore');
const issueTrackerStore    = require('../api/issueTrackerStore');
const audit                = require('../audit/logger');
const {
  InvestigationReportSchema, PlanSchema, GuardianVerdictSchema,
} = require('./schemas');
const { issueKey: _issueKey } = require('./issueKey');
const shortMemory = require('../memory/shortMemory');

const policyEngine = new PolicyEngine();

const MAX_FIX_ATTEMPTS   = 3;
const COOLDOWN_MS        = 45_000;
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000;

const RESOLUTION_CLAIM_PATTERN = /\b(confirmed to be resolved|has been resolved|is now resolved|issue is resolved|no longer (an issue|ongoing|occurring)|back (up|online)|fully recovered|recovered from)\b/i;

const EXTERNAL_OUTAGE_ROOT_CAUSE_RE = /\b(outage|disruption)\b/i;
const EXTERNAL_QUALIFIER_RE         = /\b(third[- ]party|external|provider[- ]wide)\b/i;
const CODE_CRASH_ROOT_CAUSE_RE      = /\b(nil pointer|null pointer|panic|code bug|already been restarted|crash recurs|recurs within)\b/i;
const RESTART_OR_DELETE_COMMAND_RE  = /^(rollout restart|delete pod\b)/i;

// Check if a command cannot fix the root cause
function _actionCannotAddressRootCause({ rootCause, evidenceSummary, command }) {
  const diagnosisText = String(rootCause || '');
  const commandText   = String(command || '').trim();

  if (EXTERNAL_OUTAGE_ROOT_CAUSE_RE.test(diagnosisText) && EXTERNAL_QUALIFIER_RE.test(diagnosisText)) {
    return 'root cause is a confirmed external/third-party outage — no kubectl command can fix a provider-side outage';
  }

  const recurrenceText = `${diagnosisText} ${evidenceSummary || ''}`;
  if (CODE_CRASH_ROOT_CAUSE_RE.test(recurrenceText) && RESTART_OR_DELETE_COMMAND_RE.test(commandText)) {
    return 'root cause is a recurring code-level crash — restarting or deleting the pod just recreates the same broken code, it does not fix it';
  }

  return null;
}

// Check if the issue should be escalated
function shouldEscalate(attempt) {
  return attempt >= MAX_FIX_ATTEMPTS;
}

// Check if a step needs human approval
function requiresApproval(risk, guardianApprovalRequired, reversible = true) {
  return risk === 'HIGH' || !!guardianApprovalRequired || reversible === false;
}

const WorkflowState = Annotation.Root({
  workflowId:     Annotation({ default: () => null }),
  incidents:      Annotation(),
  clusterConfigs: Annotation(),
  issues:         Annotation(),
  attempt:        Annotation({ default: () => 0 }),
  rca:            Annotation({ default: () => null }),
  podLogsByKey:   Annotation({ default: () => ({}) }),
  plan:           Annotation({ default: () => null }),
  items:          Annotation({ default: () => [] }),
  blockReason:    Annotation({ default: () => null }),
  lastAttemptFailure: Annotation({ default: () => null }),
  outcome:        Annotation({ default: () => null }),
  fastPathOutcome: Annotation({ default: () => null }),
  fastPathSeed:    Annotation({ default: () => null }),
});

// Get the config of a cluster
function _clusterFor(clusterConfigs, clusterName) {
  const found = clusterConfigs?.[clusterName];
  if (found) return found;
  console.warn(`[GRAPH] no clusterConfig found for "${clusterName}" — refusing to guess a context; caller must skip this operation`);
  return { name: clusterName, context: null, tier: 'dev' };
}

// Convert an incident to an issue
function _toIssue(incident) {
  return {
    type:         incident.type,
    complexity:   incident.complexity ?? 'UNKNOWN',
    scope:        incident.scope ?? null,
    clusterName:  incident.clusterName ?? null,
    podName:      incident.podName ?? null,
    deployment:   incident.deployment ?? null,
    namespace:    incident.namespace ?? 'default',
    nodeName:     incident.nodeName ?? null,
    exitCode:     incident.exitCode ?? null,
    oomKilled:    incident.oomKilled ?? false,
    restartCount: incident.restartCount ?? 0,
    ownerKind:    incident.deployment ? 'Deployment' : null,
    controllerName: incident.deployment ?? null,
  };
}

// Get the issue for a plan step
function _issueForStep(step, issues) {
  if (step.issueKeys?.length) {
    const found = issues.find(i => step.issueKeys.includes(_issueKey(i)));
    if (found) return found;
  }
  const targetMatch = issues.find(i =>
    step.target.kind === 'Node'
      ? i.nodeName === step.target.name
      : (i.deployment ?? i.podName) === step.target.name && (i.namespace ?? 'default') === step.target.namespace
  );
  if (targetMatch) return targetMatch;

  if (new Set(issues.map(i => i.clusterName)).size > 1) {
    console.warn(`[GRAPH] _issueForStep: step target "${step.target?.name}" matched no issue and the group spans multiple clusters — refusing to guess which one`);
    return { ...issues[0], clusterName: null };
  }
  return issues[0];
}

function _fingerprint(issue, tier) {
  return {
    issueType:     issue.type,
    oomKilled:     issue.oomKilled ?? false,
    exitCode:      issue.exitCode ?? null,
    hasDeployment: !!issue.deployment,
    tier,
    imagePrefix:   '',
  };
}

// Get the unique issues from the items
function _uniqueIssues(items) {
  return [...new Map(items.map(i => [i.key, i.issue])).values()];
}

// Check if an issue is healthy on the cluster
async function _isLiveHealthy(issue, clusterConfigs) {
  const { context } = _clusterFor(clusterConfigs, issue.clusterName);
  if (!context) return false;
  try {
    if (issue.scope !== 'node' && (issue.podName || issue.deployment)) {
      const pods = (await kubectl.getPods(issue.namespace ?? 'default', context, true))?.items ?? [];
      const named = issue.podName ? pods.find(p => p.metadata?.name === issue.podName) : null;
      if (named) return isPodHealthy(named);
      if (!issue.deployment) return false;
      const escaped = issue.deployment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ownedRe = new RegExp(`^${escaped}-[a-z0-9]{8,10}-[a-z0-9]{5}$`);
      const owned = pods.filter(p => ownedRe.test(p.metadata?.name ?? ''));
      return owned.length > 0 && owned.every(isPodHealthy);
    }
    if (issue.nodeName) {
      const node = ((await kubectl.getNodes(context))?.items ?? []).find(n => n.metadata?.name === issue.nodeName);
      if (!node || node.spec?.unschedulable) return false;
      return (node.status?.conditions ?? []).every(c => (c.type === 'Ready' ? c.status === 'True' : c.status === 'False'));
    }
  } catch { }
  return false;
}

// Resolve issues that are already healthy
async function _resolveAsAlreadyHealthy(issues, { incidentTracer, actionFor = () => null, note }) {
  await Promise.all(issues.map(async issue => {
    const key = _issueKey(issue);
    console.log(`[${issue.clusterName}] [GRAPH] ${key} live state confirms it is healthy → resolving as fixed, no command executed`);
    audit.blocked({ cluster: issue.clusterName, agent: 'guardian', action: actionFor(key), reason: 'target already healthy — no action needed', metadata: { issueKey: key } });
    incidentTracer?.step('reflector', { outcome: 'fixed', note: 'already healthy — no action needed', mttr_seconds: incidentTracer?.elapsedSeconds() ?? null },
      { resources: [{ ...resourceFromIssue(issue), issueKey: key }] });
    issueTrackerStore.resolve(key, 'fixed', note);
    await shortMemory.resolveIncident(key).catch(() => {});
  }));
}

// Fast path node
async function fastPathNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { issues, clusterConfigs, workflowId } = state;

  if (issues.length !== 1) {
    console.warn(`[GRAPH] fastPath — received ${issues.length} issues, expected exactly 1 for a SIMPLE dispatch group; falling back to the Full Investigator`);
    return { fastPathOutcome: 'escalate' };
  }

  const issue = issues[0];
  const key   = _issueKey(issue);
  const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
  const traceResource = { ...resourceFromIssue(issue), issueKey: key };

  await shortMemory.upsertIncident(key, { stage: 'investigating', issue, startedAt: new Date().toISOString() });

  incidentTracer?.start('investigator');
  const result = await fastPath.diagnose(issue, clusterConfigs);
  tracer?.attachFastPathResult(result);

  if (result.escalate) {
    console.log(`[${issue.clusterName}] [GRAPH] fastPath — escalating to Full Investigator: ${result.reason}`);
    issueTrackerStore.track(key, { stage: 'investigating', cluster: issue.clusterName, tier, issue, workflowId, note: `fast path escalated to full investigation: ${result.reason}` });
    await shortMemory.upsertIncident(key, { stage: 'investigating', issue, note: 'escalated from fast path to full investigator' });
    incidentTracer?.step('investigator', {
      path: 'fastPath', root_cause_layer: null, confidence: null, escalated: true, reason: result.reason,
    }, { resources: [traceResource] });
    return {
      fastPathOutcome: 'escalate',
      fastPathSeed: result.evidenceBundle ? { evidenceBundle: result.evidenceBundle, diagnosis: result.diagnosis } : null,
    };
  }

  const rca = fastPath.toInvestigationReport(result.diagnosis, issue, result.evidenceBundle);
  const podLogsByKey = { [key]: result.evidenceBundle?.currentLogs ?? '' };

  issueTrackerStore.track(key, {
    stage: 'investigated', cluster: issue.clusterName, tier, issue, rca, workflowId,
    note: `fast path: ${rca.suspected_cause}`,
  });
  await shortMemory.upsertIncident(key, { stage: 'investigated', issue, report: rca, completedAt: new Date().toISOString() });

  console.log(`[${issue.clusterName}] [GRAPH] fastPath — ${rca.rootCause} (confidence=${rca.confidence.toFixed(2)}) — proceeding to planner`);

  incidentTracer?.step('investigator', {
    path: 'fastPath', root_cause_layer: rca.layer ?? null, confidence: rca.confidence, escalated: false,
    sub_events: [{ layer: rca.layer ?? 'fastPath', status: 'ok', issue: rca.rootCause, confidence: rca.confidence }],
  }, { resources: [traceResource] });

  return { fastPathOutcome: 'sufficient', rca, podLogsByKey, attempt: state.attempt + 1, blockReason: null };
}

async function investigatorNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { issues, clusterConfigs, blockReason, lastAttemptFailure, workflowId, fastPathSeed } = state;
  const attempt = state.attempt + 1;
  const keys = issues.map(_issueKey);
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];

  console.log(`[${clusterNames.join(',')}] [GRAPH] investigator — ${keys.join(', ')} (attempt ${attempt}/${MAX_FIX_ATTEMPTS})${blockReason ? ` — re-diagnosing after: ${blockReason}` : ''}${fastPathSeed ? ' — resuming after a fast-path escalation' : ''}`);

  const podLogsList = await Promise.all(issues.map(async issue => {
    if (fastPathSeed && issues.length === 1) return fastPathSeed.evidenceBundle?.currentLogs ?? '';
    if (!issue.podName) return '';
    const { context } = _clusterFor(clusterConfigs, issue.clusterName);
    if (!context) return '';
    try { return await kubectl.getLogs(issue.podName, issue.namespace ?? 'default', context); }
    catch { return ''; }
  }));
  const podLogsByKey = Object.fromEntries(keys.map((k, i) => [k, podLogsList[i]]));

  const previousFindings = blockReason ? investigator.summarizeFindings(state.rca) : null;
  incidentTracer?.start('investigator');
  const rca = await investigator.investigate(issues, clusterConfigs, fastPathSeed, lastAttemptFailure, previousFindings);
  tracer?.attachInvestigatorResult(rca);

  try {
    InvestigationReportSchema.parse(rca);
  } catch (err) {
    console.warn(`[${clusterNames.join(',')}] [GRAPH] investigation report failed schema validation: ${err.message}`);
  }

  issues.forEach((issue, i) => {
    const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
    issueTrackerStore.track(keys[i], {
      stage: 'investigated', cluster: issue.clusterName, tier, issue, rca, workflowId,
      note: rca?.suspected_cause ? `suspected cause: ${rca.suspected_cause}` : 'investigation complete',
    });
  });

  const perLayerSubEvents = (rca?.perLayerFindings ?? []).map(f => ({
    layer: f.layer, status: f.status, issue: f.summary, confidence: null,
  }));
  incidentTracer?.step('investigator', {
    path: 'fullInvestigator', root_cause_layer: rca?.layer ?? null, confidence: rca?.confidence ?? null,
    sub_events: perLayerSubEvents,
  }, {
    resources: issues.map((issue, i) => ({ ...resourceFromIssue(issue), issueKey: keys[i] })),
  });

  return { podLogsByKey, rca, attempt, blockReason: null };
}

// Planner node
async function plannerNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, issues, rca, attempt, workflowId, lastAttemptFailure } = state;
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];

  incidentTracer?.start('planner');
  const plan = await planner.plan(issues, rca, clusterConfigs, lastAttemptFailure);
  tracer?.attachPlannerResult(plan);

  const items = plan.steps.map(step => {
    const issue = _issueForStep(step, issues);
    const stepWithCluster = { ...step, clusterName: issue?.clusterName ?? null };
    return { step: stepWithCluster, issue, key: _issueKey(issue), diagnosis: null, verdict: null, policyResult: null };
  });

  console.log(`[${clusterNames.join(',')}] [GRAPH] planner — ${plan.steps.length} step(s): ${plan.steps.map(s => s.command || `(${s.action}: no command)`).join(' → ')}`);

  const diag = plan._meta?.diagnostics ?? null;
  incidentTracer?.step('planner', {
    plan_summary: plan.steps.map(s => s.command || s.action).join(' → '),
    step_count:   plan.steps.length,
    needs_approval: plan.steps.some(s => s.risk === 'high' || s.risk === 'critical'),
    has_rollback:   plan.steps.some(s => s.reversible),
    noop_origin:      diag?.stopReason ?? null,
    planner_input:    diag?.plannerInput ?? null,
    tools_available:  diag?.toolsAvailable ?? null,
    last_error:       diag?.lastError ?? diag?.lastSchemaError ?? null,
    tool_call_log:    plan._meta?.toolCallLog ?? null,
    turns_used:       plan._meta?.turnsUsed ?? null,
  }, {
    resources: [...new Map(items.map(i => [i.key, { ...resourceFromIssue(i.issue), issueKey: i.key }])).values()],
  });

  const allNoop = items.every(i => !i.step.command);
  if (allNoop) {
    const noopIssues = _uniqueIssues(items);
    const health = await Promise.all(noopIssues.map(i => _isLiveHealthy(i, clusterConfigs)));
    const healthyIssues = noopIssues.filter((_, i) => health[i]);
    if (healthyIssues.length > 0) {
      await _resolveAsAlreadyHealthy(healthyIssues, {
        incidentTracer,
        note: 'already healthy — no automated fix needed, live check confirmed the target is healthy',
      });
      const healthyKeys = new Set(healthyIssues.map(_issueKey));
      const remainingItems  = items.filter(i => !healthyKeys.has(i.key));
      const remainingIssues = issues.filter(i => !healthyKeys.has(_issueKey(i)));
      if (remainingItems.length === 0) return { plan, items: [], issues: remainingIssues, outcome: 'fixed' };
      const rest = await _noopPlanOutcome(state, plan, remainingItems, diag, tracer);
      return { ...rest, issues: remainingIssues };
    }
    return _noopPlanOutcome(state, plan, items, diag, tracer);
  }

  return { plan, items };
}

// Handle a plan with no command
async function _noopPlanOutcome(state, plan, items, diag, tracer) {
  const { clusterConfigs, attempt, rca, workflowId } = state;
  const clusterNames = [...new Set(items.map(i => i.issue.clusterName))];

  if (shouldEscalate(attempt)) {
    const uniqueIssues = _uniqueIssues(items);
    console.warn(`[${clusterNames.join(',')}] [GRAPH] planner — no automated fix available + attempts exhausted (${attempt}) → escalating instead of retrying: ${uniqueIssues.map(_issueKey).join(', ')}`);
    await Promise.all(uniqueIssues.map(issue => escalationStore.escalate(_issueKey(issue), issue, [], rca)));
    tracer?.recordEscalation(uniqueIssues.length);
    const noteText = diag?.stopReason === 'submitted'
      ? `escalated after ${MAX_FIX_ATTEMPTS} attempt(s) — no automated fix available`
      : `escalated after ${MAX_FIX_ATTEMPTS} attempt(s) — planner failure (${diag?.stopReason ?? 'unknown'})`;
    uniqueIssues.forEach(issue => {
      const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
      issueTrackerStore.track(_issueKey(issue), { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: noteText });
    });
    return { plan, items, outcome: 'escalated' };
  }

  const noteText = diag?.stopReason === 'submitted'
    ? `planner found no automated fix on attempt ${attempt}/${MAX_FIX_ATTEMPTS}`
    : `planner failure on attempt ${attempt}/${MAX_FIX_ATTEMPTS} (${diag?.stopReason ?? 'unknown'})`;
  console.warn(`[${clusterNames.join(',')}] [GRAPH] planner — ${noteText}, re-investigating instead of dead-ending`);
  return { plan, items, blockReason: noteText, lastAttemptFailure: noteText };
}

async function guardianNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, attempt, rca, podLogsByKey } = state;

  const distinctTypes = [...new Set(items.map(i => i.issue.type))];
  const reflexionByType = new Map(await Promise.all(distinctTypes.map(async issueType => {
    const rep = items.find(i => i.issue.type === issueType).issue;
    const { tier } = _clusterFor(clusterConfigs, rep.clusterName);
    const fingerprint = _fingerprint(rep, tier);
    const queryText = `${rep.type} ${rep.podName ?? rep.nodeName ?? ''} ${rep.namespace ?? ''}`.trim();
    const ctx = await ReflectionAgent.getContext({ fingerprint, queryText, issueType })
      .catch(() => ({ rules: [], structuralMatches: [], semanticMatches: [] }));
    return [issueType, ctx];
  })));

  const nsClusterPairs = [...new Set(
    items.filter(i => i.issue.podName).map(i => `${i.issue.clusterName}::${i.issue.namespace ?? 'default'}`)
  )];
  const podsByClusterNs = new Map(await Promise.all(nsClusterPairs.map(async pairKey => {
    const [clusterName, ns] = pairKey.split('::');
    const { context } = _clusterFor(clusterConfigs, clusterName);
    if (!context) return [pairKey, null];
    try { return [pairKey, await kubectl.getPods(ns, context, true)]; }
    catch { return [pairKey, null]; }
  })));

  const updated = await Promise.all(items.map(async item => {
    if (!item.step.command) return item;

    const guardianStartedAt = Date.now();
    const { issue, step } = item;
    const podLogs = podLogsByKey[item.key] ?? '';
    const diagnosis = { rootCause: step.reason, action: step.action, command: step.command, risk: step.risk.toUpperCase(), rationale: step.reason };

    const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
    const guardian = new GuardianAgent(issue.clusterName, tier);
    const reflexionContext = reflexionByType.get(issue.type);
    const result = await guardian.review({ issue, diagnosis, podLogs, attempt, rca, reflexionContext });

    let stateDrift = false;
    const driftNotes = [];
    let looksHealthyNow = false;
    let targetConfirmedGone = false;
    let alreadyHealthy = false;
    if (issue.podName) {
      const pods = podsByClusterNs.get(`${issue.clusterName}::${issue.namespace ?? 'default'}`);
      const live = (pods?.items ?? []).find(p => p.metadata?.name === issue.podName);
      if (pods && !live) {
        targetConfirmedGone = true;
        stateDrift = true;
        driftNotes.push('pod no longer exists in the live cluster (namespace or pod deleted since this incident was detected)');
      }
      const containerStatuses = live?.status?.containerStatuses ?? [];
      const liveRestarts = containerStatuses.length
        ? Math.max(...containerStatuses.map(cs => cs.restartCount ?? 0))
        : null;
      if (liveRestarts != null && liveRestarts !== issue.restartCount) {
        stateDrift = true;
        driftNotes.push(`restartCount was ${issue.restartCount}, is now ${liveRestarts}`);
      }

      const livePhase = live?.status?.phase;
      const allReady = containerStatuses.length > 0 && containerStatuses.every(cs => cs.ready === true);
      const anyWaitingOrTerminated = containerStatuses.some(cs => cs.state?.waiting || cs.state?.terminated);
      looksHealthyNow = (livePhase === 'Running' || livePhase === 'Succeeded') && allReady && !anyWaitingOrTerminated;
      if (looksHealthyNow) {
        stateDrift = true;
        driftNotes.push(`pod is currently ${livePhase} with every container ready — looks healthy now, doesn't match a still-failing pod`);
      }
      alreadyHealthy = !!live && isPodHealthy(live);
    }

    if (looksHealthyNow && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} overriding verdict=${result.verdict} → REJECT: live state shows the target is already healthy, refusing to run a mutating command against it regardless of Guardian's own reasoning`);
      result.reason = `Overridden by deterministic live-health check — target is currently healthy, so no mutating command should run. Guardian's own verdict was ${result.verdict} (${result.reason})`;
      result.verdict = 'REJECT';
      result.classification = 'SAFE';
      result.suggestedCommand = null;
    }

    if (targetConfirmedGone && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} overriding verdict=${result.verdict} → REJECT: live state confirms the target pod no longer exists, refusing to run a mutating command against it regardless of Guardian's own reasoning`);
      result.reason = `Overridden by deterministic live-state check — target pod no longer exists (namespace or pod deleted since this incident was detected), nothing to fix. Guardian's own verdict was ${result.verdict} (${result.reason})`;
      result.verdict = 'REJECT';
      result.classification = 'SAFE';
      result.suggestedCommand = null;
    }

    const investigatedRootCause = rca?.rootCause ?? rca?.suspected_cause ?? null;
    let blockedReason = null;
    if (result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      blockedReason = _actionCannotAddressRootCause({
        rootCause: investigatedRootCause,
        evidenceSummary: issue.evidenceSummary,
        command: step.command,
      });
      if (blockedReason) {
        console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} overriding verdict=${result.verdict} → REJECT: ${blockedReason}`);
        result.reason = `Overridden by deterministic root-cause/action check — ${blockedReason}. Guardian's own verdict was ${result.verdict} (${result.reason})`;
        result.verdict = 'REJECT';
        result.classification = 'SAFE';
        result.suggestedCommand = null;
      }
    }

    let rootCauseFitAdvisory = null;
    if (step.command && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      rootCauseFitAdvisory = await assessRootCauseFit({
        rootCause: investigatedRootCause, command: step.command, evidenceSummary: issue.evidenceSummary,
      }).catch(err => ({ fit: 'UNCERTAIN', reason: `advisory call threw: ${err.message}`, evidenceCited: [] }));
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} root-cause-fit advisory (NOT enforced): fit=${rootCauseFitAdvisory.fit} — ${rootCauseFitAdvisory.reason}`);
    }

    const assertsUngroundedResolution = RESOLUTION_CLAIM_PATTERN.test(result.reason || '')
      && (!result.evidenceCited || result.evidenceCited.length === 0);
    if (assertsUngroundedResolution) {
      result.reason = `${result.reason} [flagged: asserts a status change with no evidenceCited to support it — routed for mandatory approval instead of auto-executing]`;
    }

    let verdict;
    try {
      verdict = GuardianVerdictSchema.parse({
        verdict:          result.verdict,
        classification:   result.classification,
        reason:           result.reason + (stateDrift ? ` (live state drift detected — ${driftNotes.join('; ')})` : ''),
        suggestedCommand: result.suggestedCommand ?? null,
        confidence:       result.confidence ?? 0.5,
        approvalRequired: result.classification === 'RISKY' || result.classification === 'DANGEROUS' || assertsUngroundedResolution,
        stateDrift,
        safetyConcerns:       result.safetyConcerns ?? [],
        evidenceCited:        result.evidenceCited ?? [],
        impactSummary:        result.impactSummary ?? null,
        estimatedBlastRadius: result.estimatedBlastRadius ?? null,
      });
    } catch (err) {
      console.error(`[${issue.clusterName}] [GRAPH] guardian — verdict failed schema validation for ${item.key}: ${err.message} — escalating instead of acting on an unvalidated verdict`);
      verdict = GuardianVerdictSchema.parse({
        verdict: 'DELEGATE_HUMAN', classification: 'DANGEROUS',
        reason: `Guardian's response failed schema validation (${err.message}) — escalated rather than executed unvalidated`,
        suggestedCommand: null, confidence: 0, approvalRequired: true, stateDrift,
        safetyConcerns: ['guardian output failed schema validation'], evidenceCited: [], impactSummary: null, estimatedBlastRadius: null,
      });
    }

    console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} (${step.command || step.action}) verdict=${verdict.verdict} class=${verdict.classification}${stateDrift ? ' [state drift detected]' : ''}`);
    tracer?.recordGuardianVerdict(verdict.verdict);
    incidentTracer?.step('guardian', {
      verdict: verdict.verdict, risk_tier: verdict.classification, rationale: verdict.reason,
      rootCauseFitAdvisory: rootCauseFitAdvisory,
    }, { resources: [{ ...resourceFromIssue(issue), issueKey: item.key }], durationMs: Date.now() - guardianStartedAt });

    return { ...item, diagnosis, verdict, investigatedRootCause, alreadyHealthy };
  }));

  return { items: updated };
}

// Policy node
async function policyNode(state, config) {
  const incidentTracer = config?.configurable?.incidentTracer;
  const byIssueKey = new Map();
  for (const item of state.items) {
    if (!byIssueKey.has(item.key)) byIssueKey.set(item.key, []);
    byIssueKey.get(item.key).push(item);
  }
  const healthyKeys = new Set([...byIssueKey].filter(([, group]) => {
    const reviewed = group.filter(i => i.step.command);
    return reviewed.length > 0 && reviewed.every(i => i.alreadyHealthy);
  }).map(([key]) => key));

  if (healthyKeys.size === 0) return _policyGate(state, state.items, config);

  await _resolveAsAlreadyHealthy([...healthyKeys].map(key => byIssueKey.get(key)[0].issue), {
    incidentTracer,
    actionFor: key => byIssueKey.get(key).map(i => i.step.command).filter(Boolean).join(' && '),
    note: 'already healthy — live check found the pod Running/Ready with no recent restarts, no command executed',
  });

  const items  = state.items.filter(i => !healthyKeys.has(i.key));
  const issues = state.issues.filter(i => !healthyKeys.has(_issueKey(i)));
  if (items.length === 0) return { items: [], issues, outcome: 'fixed' };
  return { items, issues, ...(await _policyGate(state, items, config)) };
}

// Run the policy checks on each step
async function _policyGate(state, items, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, attempt, rca, workflowId } = state;

  const delegatedByGuardian = items.find(i => i.verdict?.verdict === 'DELEGATE_HUMAN');
  if (delegatedByGuardian) {
    console.warn(`[${delegatedByGuardian.issue.clusterName}] [GRAPH] policy — DELEGATE_HUMAN (${delegatedByGuardian.key}) → immediate escalation, no further automated attempts`);
    const uniqueIssues = _uniqueIssues(items);
    await Promise.all(uniqueIssues.map(issue => escalationStore.escalate(_issueKey(issue), issue, [], rca)));
    tracer?.recordEscalation(uniqueIssues.length);
    uniqueIssues.forEach(issue => {
      const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
      issueTrackerStore.track(_issueKey(issue), { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: `Guardian delegated to human: ${delegatedByGuardian.verdict.reason}` });
    });
    audit.blocked({ cluster: delegatedByGuardian.issue.clusterName, agent: 'guardian', action: delegatedByGuardian.step.command || delegatedByGuardian.step.action, reason: `Guardian delegated to human: ${delegatedByGuardian.verdict.reason}`, metadata: { issueKey: delegatedByGuardian.key } });
    return { outcome: 'escalated' };
  }

  const rejectedItems = items.filter(i => i.verdict?.verdict === 'REJECT');
  if (rejectedItems.length > 0) {
    const byIssueKey = new Map();
    for (const item of items) {
      if (!byIssueKey.has(item.key)) byIssueKey.set(item.key, []);
      byIssueKey.get(item.key).push(item);
    }
    const anyIssueFullyRejected = [...byIssueKey.values()].some(group => group.every(i => i.verdict?.verdict === 'REJECT'));

    if (anyIssueFullyRejected) {
      const rejectedByGuardian = rejectedItems[0];
      if (shouldEscalate(attempt)) {
        console.warn(`[${rejectedByGuardian.issue.clusterName}] [GRAPH] policy — REJECT (${rejectedByGuardian.key}) + attempts exhausted → escalate plan`);
        const uniqueIssues = _uniqueIssues(items);
        await Promise.all(uniqueIssues.map(issue => escalationStore.escalate(_issueKey(issue), issue, [], rca)));
        tracer?.recordEscalation(uniqueIssues.length);
        uniqueIssues.forEach(issue => {
          const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
          issueTrackerStore.track(_issueKey(issue), { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: `escalated after ${MAX_FIX_ATTEMPTS} rejected attempt(s)` });
        });
        return { outcome: 'escalated' };
      }
      audit.blocked({ cluster: rejectedByGuardian.issue.clusterName, agent: 'guardian', action: rejectedByGuardian.step.command || rejectedByGuardian.step.action, reason: `Guardian rejected: ${rejectedByGuardian.verdict.reason}`, metadata: { issueKey: rejectedByGuardian.key } });
      return {
        blockReason: rejectedByGuardian.verdict.reason,
        lastAttemptFailure: `Guardian rejected "${rejectedByGuardian.step.command || rejectedByGuardian.step.action}": ${rejectedByGuardian.verdict.reason}`,
      };
    }

    console.warn(`[GRAPH] policy — dropping ${rejectedItems.length} Guardian-rejected step(s), proceeding with the rest of the plan: ${rejectedItems.map(i => `${i.key} (${i.step.command || i.step.action}): ${i.verdict.reason}`).join(' | ')}`);
  }

  const survivingItems = items.filter(i => i.verdict?.verdict !== 'REJECT');

  const validated = survivingItems.map(item => {
    if (!item.step.command) return item;

    const finalCommand = (item.verdict.verdict === 'MODIFY' && item.verdict.suggestedCommand)
      ? item.verdict.suggestedCommand
      : item.step.command;
    const isNodeScope  = item.step.target.kind === 'Node';
    const { tier } = _clusterFor(clusterConfigs, item.issue.clusterName);
    const hasController = !!(item.issue.deployment || item.issue.ownerKind);
    const ownerKind      = item.issue.ownerKind ?? (item.issue.deployment ? 'Deployment' : null);
    const policyPlan = { command: finalCommand, target: item.step.target, reason: item.step.reason, risk: item.step.risk.toUpperCase(), reversible: item.step.reversible };
    const policyCtx  = {
      cluster: item.issue.clusterName, issueType: item.issue.type, tier,
      hasController, ownerKind, deploymentExists: !!item.issue.deployment,
      oomKilled: item.issue.oomKilled ?? false, attemptHistory: [],
    };
    const policyResult = isNodeScope
      ? policyEngine.validateNodeCommand(policyPlan, policyCtx)
      : policyEngine.validateCommand(policyPlan, policyCtx);

    console.log(`[${item.issue.clusterName}] [GRAPH] policy — ${item.key} (${finalCommand || item.step.action}) status=${policyResult.status} command=${policyResult.command}`);

    incidentTracer?.step('policy', {
      status: policyResult.status === 'approved' ? 'PASS' : 'FAIL',
      blockedRules: policyResult.blockedRules ?? [],
      command: policyResult.command,
    }, { resources: [{ ...resourceFromIssue(item.issue), issueKey: item.key }] });

    return { ...item, policyResult, policyCtx, policyPlan };
  });

  validated.forEach(i => { if (i.policyResult?.status === 'rejected') tracer?.recordPolicyResult('rejected'); });
  const rejectedByPolicy = validated.find(i => i.policyResult?.status === 'rejected');
  if (rejectedByPolicy) {
    if (shouldEscalate(attempt)) {
      const uniqueIssues = _uniqueIssues(survivingItems);
      await Promise.all(uniqueIssues.map(issue => escalationStore.escalate(_issueKey(issue), issue, [], rca)));
      tracer?.recordEscalation(uniqueIssues.length);
      uniqueIssues.forEach(issue => {
        const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
        issueTrackerStore.track(_issueKey(issue), { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: 'policy rejected — attempts exhausted' });
      });
      return { outcome: 'escalated' };
    }
    const policyReason = rejectedByPolicy.policyResult.reason ?? rejectedByPolicy.policyResult.blockedRules?.join('; ') ?? 'policy rejected';
    return {
      blockReason: policyReason,
      lastAttemptFailure: `Policy rejected "${rejectedByPolicy.policyResult.command}": ${policyReason}`,
    };
  }

  const finalized = validated.map(item => {
    if (!item.policyResult) return item;

    let risk = item.step.risk.toUpperCase();
    const riskOverride = policyEngine.evaluateRiskOverridesForCommand({ ...item.policyPlan, command: item.policyResult.command }, item.policyCtx);
    if (riskOverride.forceApproval || riskOverride.risk !== risk) risk = riskOverride.risk;

    return { ...item, risk, finalStep: { ...item.step, command: item.policyResult.command } };
  });

  for (const item of finalized) {
    if (!item.policyResult) continue;
    if (requiresApproval(item.risk, item.verdict.approvalRequired, item.finalStep.reversible)) {
      const { tier } = _clusterFor(clusterConfigs, item.issue.clusterName);
      const approvalNote = item.finalStep.reversible === false
        ? `non-reversible step (${item.finalStep.command || item.finalStep.action}) awaiting human approval — no inverse available`
        : 'high-risk step awaiting human approval';
      issueTrackerStore.track(item.key, { stage: 'awaiting_approval', cluster: item.issue.clusterName, tier, issue: item.issue, diagnosis: item.diagnosis, workflowId, note: approvalNote });
      tracer?.recordApprovalRequest();
      const approved = await approvalStore.requestApproval({ issue: item.issue, diagnosis: { ...item.diagnosis, action: item.policyResult.command, risk: item.risk }, issueKey: item.key, guardianNote: item.verdict.reason, rca });
      if (!approved) {
        audit.blocked({ cluster: item.issue.clusterName, agent: item.issue.clusterName, action: item.policyResult.command, reason: 'approval denied or timed out', metadata: { issueKey: item.key } });
        return { outcome: 'blocked' };
      }
    }
  }

  const plan = PlanSchema.parse({
    steps: finalized.map(i => i.finalStep ?? i.step),
    nonReversible: finalized.some(i => !(i.finalStep ?? i.step).reversible),
  });

  return { items: finalized, plan };
}

// Roll back the applied steps
async function _rollback(succeeded) {
  for (const s of [...succeeded].reverse()) {
    if (!s.step.reversible || !s.step.inverseCommand) {
      console.warn(`[${s.item.issue.clusterName}] [GRAPH] executor — cannot roll back "${s.step.command}" for ${s.item.key}: step was not marked reversible`);
      continue;
    }
    try {
      await executor.execute({ command: s.step.inverseCommand, target: s.step.target }, { context: s.context });
      console.warn(`[${s.item.issue.clusterName}] [GRAPH] executor — rolled back "${s.step.command}" via "${s.step.inverseCommand}" for ${s.item.key}`);
    } catch (rbErr) {
      console.error(`[${s.item.issue.clusterName}] [GRAPH] executor — ROLLBACK FAILED for ${s.item.key} (undo of "${s.step.command}" via "${s.step.inverseCommand}"): ${rbErr.message}`);
    }
  }
}

// Execute the steps of one issue in order
async function _executeIssueSteps(group, clusterConfigs, workflowId, incidentTracer) {
  const succeeded = [];
  const finished  = [];
  let aborted = false;

  // Add a finished step and trace it
  const pushFinished = (item, executionOutcome, rest = {}) => {
    const entry = { ...item, executionOutcome, ...rest };
    finished.push(entry);
    const finalStep = item.finalStep ?? item.step;
    incidentTracer?.step('executor', {
      action: finalStep.command || finalStep.action, status: executionOutcome,
      ...(rest.executionError ? { reason: rest.executionError } : {}),
      ...(rest.executionNote  ? { note: rest.executionNote }   : {}),
    }, { resources: [{ ...resourceFromIssue(item.issue), issueKey: item.key }] });
    return entry;
  };

  for (const item of group) {
    if (aborted) {
      pushFinished(item, 'skipped', { executionError: 'aborted — an earlier step in this issue\'s plan failed' });
      continue;
    }
    if (!item.step.command) { pushFinished(item, 'skipped'); continue; }

    const step = item.finalStep ?? item.step;
    if (step.clusterName && step.clusterName !== item.issue.clusterName) {
      console.warn(`[GRAPH] executor — step.clusterName ("${step.clusterName}") disagrees with issue.clusterName ("${item.issue.clusterName}") for ${item.key}; using issue.clusterName`);
    }
    const { context } = _clusterFor(clusterConfigs, item.issue.clusterName);
    issueTrackerStore.track(item.key, { stage: 'approved', cluster: item.issue.clusterName, tier: _clusterFor(clusterConfigs, item.issue.clusterName).tier, issue: item.issue, workflowId, note: `executing: ${step.command}` });

    if (!context) {
      console.error(`[GRAPH] executor — refusing to execute for ${item.key}: cluster "${item.issue.clusterName}" is not a known cluster`);
      pushFinished(item, 'blocked', { executionError: `unknown cluster "${item.issue.clusterName}"` });
      aborted = true;
      continue;
    }

    try {
      await executor.execute(step, { context });
      succeeded.push({ item, step, context });

      const unverifiedReason = _actionCannotAddressRootCause({
        rootCause: item.investigatedRootCause,
        evidenceSummary: item.issue.evidenceSummary,
        command: step.command,
      });

      let healthy = true, healthReason = unverifiedReason;
      if (!unverifiedReason && !policyEngine.dryRunMode) {
        const verification = await verifyResourceHealthy(step, { issue: item.issue, context });
        healthy = verification.healthy;
        healthReason = verification.reason;
      } else if (unverifiedReason) {
        healthy = false;
      }

      if (healthy) {
        pushFinished(item, 'fixed');
      } else {
        console.warn(`[${item.issue.clusterName}] [GRAPH] executor — ${item.key} ran "${step.command}" but it did not verify as fixed: ${healthReason}`);
        pushFinished(item, 'blocked', { executionError: healthReason });
        aborted = true;
        await _rollback(succeeded);
      }
    } catch (err) {
      console.error(`[${item.issue.clusterName}] [GRAPH] executor failed for ${item.key} (${step.command}): ${err.message}`);
      pushFinished(item, 'blocked', { executionError: err.message });
      aborted = true;
      await _rollback(succeeded);
    }
  }

  return finished;
}

// Get the resolution of an issue
function _issueResolution(steps) {
  const actionableSteps = steps.filter(s => s.executionOutcome && s.executionOutcome !== 'skipped');
  const resolved = actionableSteps.length > 0 && actionableSteps.every(s => s.executionOutcome === 'fixed');
  return { actionableSteps, resolved };
}

async function executorNode(state, config) {
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, workflowId, attempt } = state;

  const byIssue = new Map();
  for (const item of items) {
    if (!byIssue.has(item.key)) byIssue.set(item.key, []);
    byIssue.get(item.key).push(item);
  }

  const grouped = await Promise.all(
    [...byIssue.values()].map(group => _executeIssueSteps(group, clusterConfigs, workflowId, incidentTracer))
  );
  const results = grouped.flat();

  const actionable = results.filter(r => r.executionOutcome !== 'skipped');
  const outcome = actionable.length === 0 || actionable.some(r => r.executionOutcome === 'fixed')
    ? 'fixed'
    : 'blocked';

  const issueKeys = [...byIssue.keys()];
  const unresolved = [];
  for (const key of issueKeys) {
    const group = byIssue.get(key);
    const groupResults = grouped[issueKeys.indexOf(key)];
    const { actionableSteps, resolved } = _issueResolution(groupResults);
    incidentTracer?.step('executor', {
      summary: groupResults.map(r => `${(r.finalStep ?? r.step).command || (r.finalStep ?? r.step).action}:${r.executionOutcome}`).join(' · '),
      ready: resolved,
    }, { resources: [{ ...resourceFromIssue(group[0].issue), issueKey: key }] });
    if (actionableSteps.length > 0 && !resolved) unresolved.push({ key, groupResults });
  }

  let blockReason = null;
  let lastAttemptFailure = null;
  if (unresolved.length > 0 && !shouldEscalate(attempt)) {
    blockReason = unresolved
      .map(({ key, groupResults }) => {
        const failed = groupResults.find(r => r.executionError || r.executionNote);
        return `${key}: ${failed?.executionError ?? failed?.executionNote ?? 'did not verify fixed'}`;
      })
      .join(' | ');
    lastAttemptFailure = unresolved
      .map(({ key, groupResults }) => {
        const failed = groupResults.find(r => r.executionError || r.executionNote);
        const failedStep = failed?.finalStep ?? failed?.step;
        const cmd = failedStep?.command || failedStep?.action || 'unknown command';
        return `${key}: tried "${cmd}" — ${failed?.executionError ?? failed?.executionNote ?? 'did not verify fixed'}`;
      })
      .join(' | ');
    console.warn(`[GRAPH] executor — ${unresolved.map(u => u.key).join(', ')} did not verify fixed (attempt ${attempt}/${MAX_FIX_ATTEMPTS}) → re-investigating`);
  }

  return { items: results, outcome, blockReason, lastAttemptFailure };
}

async function reflexionNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, outcome, blockReason, attempt, rca, podLogsByKey, workflowId } = state;

  const byIssue = new Map();
  for (const item of items) {
    if (!byIssue.has(item.key)) byIssue.set(item.key, { issue: item.issue, steps: [] });
    byIssue.get(item.key).steps.push(item);
  }

  await Promise.all([...byIssue.entries()].map(async ([key, { issue, steps }]) => {
    const { actionableSteps, resolved } = _issueResolution(steps);
    let itemOutcome = actionableSteps.length === 0 ? (outcome ?? 'failed') : (resolved ? 'fixed' : 'blocked');

    if (actionableSteps.length > 0 && !resolved && shouldEscalate(attempt)) {
      console.warn(`[${issue.clusterName}] [GRAPH] reflexion — ${key} still not verified fixed after ${MAX_FIX_ATTEMPTS} attempt(s) → escalating`);
      await escalationStore.escalate(key, issue, [], rca).catch(() => {});
      tracer?.recordEscalation(1);
      const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
      issueTrackerStore.track(key, { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: `escalated after ${MAX_FIX_ATTEMPTS} execution attempt(s) that did not verify fixed` });
      itemOutcome = 'escalated';
    }

    const podLogs        = podLogsByKey[key] ?? '';
    const primaryStep    = steps[0]?.finalStep ?? steps[0]?.step;
    const primaryCommand = primaryStep?.command || primaryStep?.action || 'unknown';

    const reflection = await ReflectionAgent.reflect({
      issue, planAction: primaryCommand, rootCauseDiagnosis: rca?.suspected_cause ?? 'unknown',
      timeline: [], resolved, podLogs, rca,
    }).catch(() => null);

    if (reflection) {
      const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
      await episodicMemory.store({
        fingerprint: _fingerprint(issue, tier),
        context: { issue, podLogsSnippet: podLogs?.slice(-500) ?? '' },
        timeline: steps.map(s => {
          const finalized = s.finalStep ?? s.step;
          return { action: finalized.action, command: finalized.command, outcome: s.executionOutcome ?? itemOutcome, at: new Date() };
        }),
        reflection, resolved, resolvedAction: resolved ? primaryCommand : null,
        totalAttempts: attempt, rca: rca ?? undefined,
      }).catch(() => {});
      if (!resolved) await ruleEngine.analyze(issue.type).catch(() => {});
    }

    incidentTracer?.step('reflector', {
      outcome: resolved ? 'fixed' : itemOutcome,
      rca_accuracy: reflection?.confidence ?? null,
      mttr_seconds: incidentTracer?.elapsedSeconds() ?? null,
    }, { resources: [{ ...resourceFromIssue(issue), issueKey: key }] });

    issueTrackerStore.resolve(
      key,
      resolved ? 'fixed' : itemOutcome,
      resolved ? `resolved via: ${primaryCommand}` : (blockReason ?? itemOutcome)
    );

    if (resolved) {
      await shortMemory.resolveIncident(key).catch(() => {});
    } else {
      const cooldownMs = itemOutcome === 'escalated' ? ESCALATION_COOLDOWN_MS : COOLDOWN_MS;
      await Promise.all([
        shortMemory.incrementAttempt(key),
        shortMemory.setCooldown(key, cooldownMs),
      ]).catch(() => {});
    }
  }));

  return {};
}

// Route by incident complexity
function routeByComplexity(state) {
  return (state.issues.length === 1 && state.issues[0].complexity === 'SIMPLE') ? 'fastPath' : 'investigator';
}

function routeAfterFastPath(state) {
  return state.fastPathOutcome === 'sufficient' ? 'planner' : 'investigator';
}

function routeAfterPlanner(state) {
  if (state.blockReason) return 'investigator';
  const allNoop = state.items.every(i => !i.step.command);
  return allNoop ? 'reflexion' : 'guardian';
}

function routeAfterPolicy(state) {
  if (state.items?.length === 0) return 'reflexion';
  if (state.outcome === 'escalated' || state.outcome === 'blocked') return 'reflexion';
  if (state.blockReason) return 'investigator';
  return 'executor';
}

// Route after the executor
function routeAfterExecutor(state) {
  return state.blockReason ? 'investigator' : 'reflexion';
}

// Wrap a node with timing
function _traced(name, fn) {
  return async (state, config) => {
    const tracer = config?.configurable?.tracer;
    tracer?.startNode(name);
    try {
      return await fn(state, config);
    } finally {
      tracer?.endNode(name);
    }
  };
}

const graph = new StateGraph(WorkflowState)
  .addNode('fastPath',     _traced('fastPath', fastPathNode))
  .addNode('investigator', _traced('investigator', investigatorNode))
  .addNode('planner',      _traced('planner', plannerNode))
  .addNode('guardian',     _traced('guardian', guardianNode))
  .addNode('policy',       _traced('policy', policyNode))
  .addNode('executor',     _traced('executor', executorNode))
  .addNode('reflexion',    _traced('reflexion', reflexionNode))
  .addConditionalEdges(START, routeByComplexity, { fastPath: 'fastPath', investigator: 'investigator' })
  .addConditionalEdges('fastPath', routeAfterFastPath, { planner: 'planner', investigator: 'investigator' })
  .addEdge('investigator', 'planner')
  .addConditionalEdges('planner', routeAfterPlanner, { guardian: 'guardian', reflexion: 'reflexion', investigator: 'investigator' })
  .addEdge('guardian', 'policy')
  .addConditionalEdges('policy', routeAfterPolicy, { investigator: 'investigator', executor: 'executor', reflexion: 'reflexion' })
  .addConditionalEdges('executor', routeAfterExecutor, { investigator: 'investigator', reflexion: 'reflexion' })
  .addEdge('reflexion', END);

const compiled = graph.compile();

// Run the workflow for a group of incidents
async function runWorkflow({ incidents, clusterConfigs, workflowId = randomUUID(), incidentTracer = null }) {
  const issues = incidents.map(_toIssue);
  const incTracer = incidentTracer ?? new IncidentTracer({ workflowId, resource: resourceFromIssue(issues[0]) });

  const attemptCounts = await Promise.all(issues.map(i => shortMemory.attemptCount(_issueKey(i))));
  const attempt = Math.max(0, ...attemptCounts);

  const tracer = new WorkflowTracer({
    workflowId,
    clusters:     [...new Set(issues.map(i => i.clusterName))],
    namespace:    issues[0]?.namespace ?? null,
    incidentType: issues[0]?.type ?? null,
    complexity:   issues.length === 1 ? (issues[0]?.complexity ?? 'UNKNOWN') : 'COMPLEX',
    issueKeys:    issues.map(_issueKey),
    pipeline:     'v5',
  });

  const { result, usage } = await tokenStore.withScope(() => compiled.invoke({
    incidents, clusterConfigs, issues, workflowId,
    attempt, rca: null, podLogsByKey: {}, plan: null, items: [], blockReason: null, outcome: null, lastAttemptFailure: null,
  }, {
    recursionLimit: MAX_FIX_ATTEMPTS * 6 + 10,
    configurable: { tracer, incidentTracer: incTracer },
  }));

  tracer.attachTokenUsage(usage);
  console.log(`[GRAPH] workflow ${workflowId} — tokens: input=${usage.total.prompt} (cached=${usage.total.cached}) output=${usage.total.completion} across ${usage.total.calls} LLM call(s) — ${Object.entries(usage.agents).map(([a, c]) => `${a}=${c.prompt}`).join(', ') || 'none'}`);
  tracer.finalize(result.outcome);
  workflowTraceStore.save(tracer.toDocument()).catch(() => {});
  liveWorkflowStore.finish(workflowId, result.outcome);

  return result;
}

module.exports = {
  runWorkflow,
  graph: compiled,
  routeAfterPlanner, routeAfterPolicy, shouldEscalate, requiresApproval, MAX_FIX_ATTEMPTS,
  routeByComplexity, routeAfterFastPath,
  fastPathNode,
  guardianNode,
  _toIssue,
  _clusterFor,
  _issueForStep,
  _actionCannotAddressRootCause,
  routeAfterExecutor, _issueResolution,
};
