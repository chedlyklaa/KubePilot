'use strict';
const { randomUUID } = require('crypto');
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');

// Cluster access goes through the k8s gateways — in-process by default, separate
// credential-holding services with AGENT_K8S_READ_MODE / AGENT_K8S_WRITE_MODE=remote.
const { k8sRead, k8sWrite } = require('../tools/k8sGateway');
const { getBus } = require('../mesh/busSingleton');
const WorkflowTracer       = require('../monitoring/workflowTracer');
const { IncidentTracer, resourceFromIssue } = require('../monitoring/incidentTracer');
const liveWorkflowStore    = require('../monitoring/liveWorkflowStore');
const workflowTraceStore   = require('../api/workflowTraceStore');
// fastPath is still required directly for its PURE toInvestigationReport() helper; every
// agent CALL goes through its client (src/agents/agentClients.js) — in-process by
// default, that agent's own service with AGENT_<NAME>_MODE=remote. Task ids passed to
// the clients are deterministic per (workflow, node, attempt[, item]) so a redelivered
// or re-sent request replays the stored answer instead of re-running an LLM loop.
const fastPath             = require('../agents/fastPath');
const {
  fastPathClient, investigatorClient, plannerClient, guardianClient, reflectionClient,
} = require('../agents/agentClients');
const overrideStore        = require('../api/overrideStore');
const { assessRootCauseFit } = require('../agents/rootCauseFitAssessor');
const PolicyEngine         = require('../policy/policyEngine');
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
const COOLDOWN_MS        = 45_000; // same value as clusterAgent.js's this.COOLDOWN_MS
// §Fix-EscalationSpam (2026-09-04) — an escalated incident (DELEGATE_HUMAN, REJECT with
// attempts exhausted, or §Fix-NoopEscalation's no-automated-fix path) used to get the
// exact same COOLDOWN_MS as a normal failed attempt, which meant it would re-escalate —
// spamming escalationStore/notifications — every 45s forever instead of giving a human
// real time to act before the automated pipeline tries again. This only slows down the
// AUTOMATED retry loop; it doesn't gate escalationStore/approvalStore themselves, so a
// human can still act on it immediately.
const ESCALATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// §Fix-P10 (2026-08-28) — phrases that assert a condition CHANGED (resolved/recovered/
// back up) rather than merely describing the original incident. Confirmed live: Guardian
// reliably writes reasons like "the outage has been resolved" / "is confirmed to be
// resolved" with nothing in the evidence actually saying so. Prompt-only guardrails
// (asking the model to cite evidence) didn't stop it, so this is used as a deterministic
// check in guardianNode: if the reason makes this kind of claim AND evidenceCited is
// empty, the verdict can't be trusted to auto-execute — see the approvalRequired override
// below.
const RESOLUTION_CLAIM_PATTERN = /\b(confirmed to be resolved|has been resolved|is now resolved|issue is resolved|no longer (an issue|ongoing|occurring)|back (up|online)|fully recovered|recovered from)\b/i;

// §Fix-RootCauseGate (2026-08-31) — a third deterministic override, same place and same
// reasoning as §Fix-P8 in guardianNode: Guardian's own prompt-level judgment has proven
// repeatedly unreliable at catching cases where the proposed command CANNOT possibly
// address the diagnosed root cause — it rubber-stamps "rollout restart" as a safe,
// low-risk action without checking whether restarting anything actually touches the real
// problem. Confirmed live (2026-08-31): P9's Investigator correctly diagnosed "a nil
// pointer dereference" (a code bug, not a transient blip) and Guardian still approved a
// plain restart with reason "a reasonable approach to trigger a fresh pod instantiation"
// — a restart cannot fix a code bug, it just re-runs the same broken code. Same pattern
// for P10's confirmed third-party outages, approved with "restart... once the external
// service is restored" — restarting a pod does nothing to a provider's own outage. Both
// are judgment failures a deterministic check on the DIAGNOSIS TEXT (not the command's
// syntax — PolicyEngine already owns that) can catch instead of trusting the prompt.
//
// Deliberately narrow, two-part (AND) patterns rather than one broad word list — a single
// word like "outage" or "recurs" alone is common enough in legitimate, fixable incidents
// that a bare match would start rejecting good restarts (see graph.test.js's control
// cases: a P1-style transient-dependency restart must NOT trip either rule).
const EXTERNAL_OUTAGE_ROOT_CAUSE_RE = /\b(outage|disruption)\b/i;
const EXTERNAL_QUALIFIER_RE         = /\b(third[- ]party|external|provider[- ]wide)\b/i;
const CODE_CRASH_ROOT_CAUSE_RE      = /\b(nil pointer|null pointer|panic|code bug|already been restarted|crash recurs|recurs within)\b/i;
const RESTART_OR_DELETE_COMMAND_RE  = /^(rollout restart|delete pod\b)/i;

// Pure — plain strings in, a reason string (or null) out — so it's directly unit-testable
// and reusable verbatim from the Executor's post-execution outcome label (see
// §Fix-ExecutorHonesty in _executeIssueSteps) without reconstructing any pipeline state.
function _actionCannotAddressRootCause({ rootCause, evidenceSummary, command }) {
  const diagnosisText = String(rootCause || '');
  const commandText   = String(command || '').trim();

  if (EXTERNAL_OUTAGE_ROOT_CAUSE_RE.test(diagnosisText) && EXTERNAL_QUALIFIER_RE.test(diagnosisText)) {
    return 'root cause is a confirmed external/third-party outage — no kubectl command can fix a provider-side outage';
  }

  // evidenceSummary included too — the "already restarted"/"recurs" signal about a prior
  // failed remediation attempt lives in the ORIGINAL incident report the Orchestrator
  // produced, and isn't always echoed back into the Investigator's own rootCause prose.
  const recurrenceText = `${diagnosisText} ${evidenceSummary || ''}`;
  if (CODE_CRASH_ROOT_CAUSE_RE.test(recurrenceText) && RESTART_OR_DELETE_COMMAND_RE.test(commandText)) {
    return 'root cause is a recurring code-level crash — restarting or deleting the pod just recreates the same broken code, it does not fix it';
  }

  return null;
}

// Pure decision helpers — pulled out of policyNode so verdict/attempt → branch mapping
// is unit-testable without mocking the whole agent/store dependency graph.
function shouldEscalate(attempt) {
  return attempt >= MAX_FIX_ATTEMPTS;
}

// §7.7 — a step the Planner honestly declared non-reversible (no safe inverse) must
// force human approval regardless of its risk tier or Guardian's own read: reversibility
// is exactly the property that makes an autonomous mistake cheap to undo, so losing it
// is itself a reason for a human gate, independent of how risky the action looked. No
// more fixed HIGH_RISK_ACTIONS set — the Planner writes free-form commands now, so risk
// tier / Guardian's read / reversibility are the only signals left to gate on (see
// policyEngine.evaluateRiskOverridesForCommand for how `risk` itself gets escalated).
function requiresApproval(risk, guardianApprovalRequired, reversible = true) {
  return risk === 'HIGH' || !!guardianApprovalRequired || reversible === false;
}

// §Fix-RiskEngineRetirement (2026-09-18) — this file used to also compute a THIRD,
// independent "how risky is this" score here via `_classifyCommandRisk()` (a regex
// guess at the command's category) feeding `riskEngine.calculateRisk()`
// (src/risk/engine.js's hand-tuned weighted formula), whose BLOCK verdict could force
// `risk` to HIGH on top of whatever Guardian's classification and
// PolicyEngine.evaluateRiskOverridesForCommand's own floors already produced.
//
// Investigated before removing it (per the architecture review this fix implements):
// every concrete case worked through by hand — OOM+resource-change, prod-tier
// escalation, deployment-pod-delete, a non-reversible step, cluster criticality —
// was ALREADY covered by one of evaluateRiskOverridesForCommand's own floors, which
// run first. The one case where the formula's independent blast-radius scoring could
// in principle matter on its own — a `drain` node command Guardian did NOT classify
// RISKY/DANGEROUS and the Planner marked reversible — never actually crossed the
// formula's own BLOCK threshold in any tier once worked through numerically (the
// non-reversible floor already catches the case that does). The one place the
// LEGACY pipeline's fixed HIGH_RISK_ACTIONS set (clusterAgent.js) still unconditionally
// forces approval that this file's floors didn't already cover on their own — draining
// a node — has been restored as an explicit, named floor directly in
// PolicyEngine.evaluateRiskOverridesForCommand instead (see that function's own
// comment), so the one real safety property is kept, owned by PolicyEngine, and no
// longer duplicated through an opaque formula. RiskEngine itself (src/risk/engine.js)
// is untouched and still used by the legacy ClusterAgent pipeline and its own
// dedicated regression benchmark (benchmark/runner/run.js) — out of scope here since
// that pipeline is CLI-only/dormant and its benchmark specifically exists to test that
// exact decision layer in isolation.

// Deferred beyond this pass (scoped out to keep the graph-node port bounded):
// evidence-sufficiency gate, temporal repeated-failure pattern detection, silenceStore,
// the "UNCERTAIN" evidence-confidence risk tier. All still live in ClusterAgent's path.

// ── Graph state ──────────────────────────────────────────────────────────
// A workflow runs over a LIST of incidents (§7.6/§9.1 — namespace-grouped dispatch,
// now fleet-wide — the same namespace across several clusters can land in one group).
// `clusterConfigs` replaces the old single shared `clusterConfig`: a plain object map
// `{ [clusterName]: { name, context, tier } }` covering the WHOLE fleet (not just the
// cluster(s) obviously present in this group's incidents — cheap to pass in full, and a
// re-diagnose loop could otherwise need to resolve a cluster that wasn't in the initial
// incident list). Every node resolves its OWN per-item/per-issue cluster via
// `_clusterFor(clusterConfigs, clusterName)` instead of reading one shared value.
// `rca` is ONE shared investigation report covering the whole group (which may itself
// span clusters). `plan` is a real multi-step plan (§3.3) from src/agents/planner.js —
// steps don't necessarily map 1:1 to incidents (one incident's fix might be several
// steps; one step might address several incidents). `items` is therefore STEP-centric,
// one entry per plan step, each resolved back to the issue(s) it addresses via
// _issueForStep().
const WorkflowState = Annotation.Root({
  // Measurement (Phase 1) — cross-links this run to its WorkflowTrace document
  // (src/db/models/history.js) and to every IssueTracker entry it touches. Seeded by
  // runWorkflow() below; a plain data field, never read by any prompt-building code.
  workflowId:     Annotation({ default: () => null }),
  incidents:      Annotation(),
  clusterConfigs: Annotation(),
  issues:         Annotation(),
  attempt:        Annotation({ default: () => 0 }),
  rca:            Annotation({ default: () => null }),
  podLogsByKey:   Annotation({ default: () => ({}) }), // issueKey -> podLogs, set once by investigatorNode
  plan:           Annotation({ default: () => null }),
  items:          Annotation({ default: () => [] }),   // [{ step, issue, key, diagnosis, verdict, policyResult, finalStep, executionOutcome }]
  blockReason:    Annotation({ default: () => null }),
  // Unlike blockReason (cleared by investigatorNode every time it runs, since it only
  // drives THIS pass's routing), this persists across the investigator/planner hop within
  // one retry cycle — set by any node that finds a previous attempt didn't work (Guardian
  // REJECT, Policy rejection, an executed-but-unverified command, or an all-noop plan),
  // and read by investigatorNode/plannerNode on the NEXT attempt so a retry can actually
  // avoid repeating the same mistake instead of re-deriving it blind (§Fix-RetryContext,
  // 2026-09-14 — confirmed live: mk-overscaled retried the identical insufficient
  // `--replicas=24` twice in a row with no adjustment). Never explicitly cleared — each
  // new failure just overwrites it with the most recent one.
  lastAttemptFailure: Annotation({ default: () => null }),
  outcome:        Annotation({ default: () => null }), // 'fixed' | 'blocked' | 'escalated'
  // Phase 2 (Fast Path) — written by fastPathNode, read by routeAfterFastPath.
  // 'sufficient' | 'escalate' | null (null until fastPathNode has run).
  fastPathOutcome: Annotation({ default: () => null }),
  // Populated only when fastPathNode escalates: { evidenceBundle, diagnosis } — handed
  // to the Full Investigator (investigatorNode) so its ring-0 gathering doesn't have to
  // re-run the same describe/logs calls Fast Path already made, and so the model sees
  // Fast Path's own (sub-threshold) hypothesis as a starting point, not a blind slate.
  fastPathSeed:    Annotation({ default: () => null }),
});

// Resolves one cluster's { name, context, tier } out of the fleet-wide clusterConfigs
// map. `clusterName` here traces back to the LLM's own classification output — NOT a
// value constrained to a known-safe enum the way Investigator's/Planner's tool
// parameters are — so it must be treated as untrusted. On a miss this returns
// context: null rather than reusing clusterName itself as a fallback context string:
// an earlier version did exactly that ("best-effort stub: context=clusterName"), and a
// live two-cluster test (2026-08-26) showed the classifier can hallucinate an entire
// incident under a clusterName that happens to match a REAL cluster the user runs
// outside this workflow's intended scope — with the old fallback, that hallucinated
// name would have been used verbatim as a real kubectl --context value. Every call site
// that resolves a context through this function MUST check for null and skip/refuse
// the operation rather than attempt it — see investigatorNode/guardianNode/executorNode.
function _clusterFor(clusterConfigs, clusterName) {
  const found = clusterConfigs?.[clusterName];
  if (found) return found;
  console.warn(`[GRAPH] no clusterConfig found for "${clusterName}" — refusing to guess a context; caller must skip this operation`);
  return { name: clusterName, context: null, tier: 'dev' };
}

// Incident (Orchestrator's classification) → issue-shaped object the ported
// Guardian/Reflection agents already know how to consume.
function _toIssue(incident) {
  return {
    type:         incident.type,
    // Phase 2 (Fast Path) — previously dropped here entirely, which is why the
    // Orchestrator's SIMPLE/COMPLEX classification never reached any routing decision
    // despite being computed. routeByComplexity below is the first real consumer.
    complexity:   incident.complexity ?? 'UNKNOWN',
    // Preserved verbatim (not re-inferred) so _issueKey(issue) here agrees with
    // issueKey(incident) in orchestratorAgent.js — inferring scope from field presence
    // after this adaptation can disagree with the LLM's own explicit classification
    // (e.g. a pod-scoped incident that also carries nodeName), desyncing cooldown/
    // tracking/escalation keys for the same incident across the two call sites.
    scope:        incident.scope ?? null,
    // clusterName MUST come through here — this is the one place it used to get
    // silently dropped even in the single-cluster design (escalationStore.escalate()/
    // approvalStore.requestApproval() both read issue?.clusterName and got `undefined`
    // from every graph.js-originated issue before this fix). Now load-bearing for the
    // multi-cluster redesign too: issueKey()'s cluster-prefixed key only works if the
    // object it's given actually carries this field.
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

// _issueKey (imported above from ./issueKey, shared with orchestratorAgent.js/
// planner.js/investigator.js) — every issueTrackerStore/escalationStore/approvalStore
// call below is keyed per INDIVIDUAL issue, not the group or the step, so the
// dashboard shows each app's own timeline even though the workflow itself is
// grouped/multi-step.

// Resolve which issue a plan step addresses: prefer the Planner's own declared
// issueKeys, fall back to matching by target identity if it omitted them.
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

  // No match by issueKeys or target identity — falling back to an arbitrary issue
  // (issues[0]) is only safe when every issue in the group shares one cluster, since
  // plannerNode uses the returned issue's clusterName to route the step's real
  // execution context. Found in review, 2026-08-26: with multiple clusters in the
  // group this could silently route a step to the WRONG cluster. When that's the
  // case, null out clusterName instead of guessing — the same null-context guards
  // already added for hallucinated clusters (investigatorNode/guardianNode/
  // executorNode) then safely refuse to act on it rather than picking one.
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

// One entry per distinct issue key present in `items` — several steps can share one
// issue, so escalation/tracking calls must be de-duplicated down to one per issue.
function _uniqueIssues(items) {
  return [...new Map(items.map(i => [i.key, i.issue])).values()];
}

// ── Nodes ────────────────────────────────────────────────────────────────

// src/agents/fastPath.js — deterministic-evidence, single-LLM-call alternative to the
// full Investigator (architecture-doc-adjacent Phase 2 work) for incidents the
// Orchestrator classified SIMPLE. Only ever reached from START (see routeByComplexity
// below) for a length-1 issue group — a SIMPLE incident is, by the Orchestrator's own
// classification rule (orchestratorAgent.js: no shared correlationTag with another
// incident), always a solo dispatch group, so a group reaching here with more than one
// issue means something upstream disagreed with its own classification; fail safe to
// the Full Investigator for the whole group rather than guessing which issue to look at.
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
  // The in-process agents never throw (they catch internally and degrade); only the bus
  // transport can (remote mode: timeout, dead-letter, service down). Every agent call
  // below degrades to that same local fallback instead of failing the whole workflow.
  const result = await fastPathClient.diagnose({ issue, clusterConfigs }, { taskId: `${workflowId}:fastpath`, workflowId })
    .catch(err => ({ escalate: true, reason: `fast path unavailable: ${err.message}`, evidenceBundle: null, diagnosis: null, toolCallCount: 0 }));
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

  // attempt/blockReason mirror investigatorNode's own return shape exactly, since
  // fastPathNode is a drop-in alternative entry point for the SAME first hop —
  // plannerNode/policyNode's shouldEscalate()/MAX_FIX_ATTEMPTS logic must see the
  // identical state shape regardless of which path produced it.
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

  // A fastPathSeed can only exist for a length-1 group (see fastPathNode/routeByComplexity)
  // — reuse the logs it already fetched instead of re-running the identical kubectl call.
  const podLogsList = await Promise.all(issues.map(async issue => {
    if (fastPathSeed && issues.length === 1) return fastPathSeed.evidenceBundle?.currentLogs ?? '';
    if (!issue.podName) return '';
    const { context } = _clusterFor(clusterConfigs, issue.clusterName);
    // A null context means issue.clusterName didn't resolve against the real fleet map
    // (see _clusterFor) — never attempt a kubectl call with an unresolved/untrusted
    // context, just treat it the same as "logs unavailable".
    if (!context) return '';
    try { return await k8sRead.getLogs({ podName: issue.podName, namespace: issue.namespace ?? 'default', context }); }
    catch { return ''; }
  }));
  const podLogsByKey = Object.fromEntries(keys.map((k, i) => [k, podLogsList[i]]));

  // src/agents/investigator.js — standalone, free-form execution-layer Investigator
  // (architecture-doc §3.2/§7.6). Reasons over the WHOLE group in one agentic loop —
  // now potentially spanning clusters, since investigator.js's tool takes a per-call
  // clusterName parameter resolved against the full clusterConfigs map, letting the
  // model inspect and compare evidence across clusters within one continuous loop.
  // `fastPathSeed` (Phase 2) is passed through so the loop can be told what Fast Path
  // already gathered/concluded instead of starting blind — see investigator.js's
  // SYSTEM_PROMPT "fastPathContext" paragraph and _runInvestigationLoop's initial message.
  incidentTracer?.start('investigator');
  const rca = await investigatorClient.investigate(
    { issues, clusterConfigs, fastPathSeed: fastPathSeed ?? null, lastAttemptFailure: lastAttemptFailure ?? null },
    { taskId: `${workflowId}:investigate:${attempt}`, workflowId },
  ).catch(err => {
    console.warn(`[${clusterNames.join(',')}] [GRAPH] investigator unavailable (${err.message}) — using the fallback report`);
    return require('../agents/investigator')._fallback(issues);
  });
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

  // Investigator reasons over the WHOLE group in one call (rca is shared), so one
  // decision fans out to one trace line per pod — allSettled-style resilience: even if
  // rca.perLayerFindings is empty/malformed, the outer event still logs (root cause +
  // confidence), it just carries no sub_events rather than blanking the whole entry.
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

// src/agents/planner.js — standalone, agentic multi-step Planner (architecture-doc
// §3.3): one call for the whole group, produces a real ordered plan (dry_run_step and
// gather_more_evidence tools available to it internally), not a loop of single actions.
async function plannerNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, issues, rca, attempt, workflowId, lastAttemptFailure } = state;
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];

  incidentTracer?.start('planner');
  const plan = await plannerClient.plan(
    { issues, rca, clusterConfigs, lastAttemptFailure: lastAttemptFailure ?? null },
    { taskId: `${workflowId}:plan:${attempt}`, workflowId },
  ).catch(err => {
    console.warn(`[${clusterNames.join(',')}] [GRAPH] planner unavailable (${err.message}) — using the no-op fallback plan`);
    const fallback = require('../agents/planner')._fallbackPlan(issues);
    return { ...fallback, _meta: { turnsUsed: 0, toolCallLog: [], diagnostics: { stopReason: 'planning_exception', lastError: err.message } } };
  });
  tracer?.attachPlannerResult(plan);

  const items = plan.steps.map(step => {
    const issue = _issueForStep(step, issues);
    // clusterName is UNCONDITIONALLY overwritten here from the resolved issue, not
    // trusted from whatever (if anything) the model put in the step itself — see the
    // comment on PlanStepSchema.clusterName in schemas.js for why.
    const stepWithCluster = { ...step, clusterName: issue?.clusterName ?? null };
    return { step: stepWithCluster, issue, key: _issueKey(issue), diagnosis: null, verdict: null, policyResult: null };
  });

  console.log(`[${clusterNames.join(',')}] [GRAPH] planner — ${plan.steps.length} step(s): ${plan.steps.map(s => s.command || `(${s.action}: no command)`).join(' → ')}`);

  // DIAGNOSTIC (noop-repro investigation, 2026-09-11 — easy to remove: delete this
  // block down to "diagnostic end" plus the matching changes in src/agents/planner.js).
  // plan._meta.diagnostics is planner.js's own record of which internal branch actually
  // produced this plan — surfaced here because this trace pipe (IncidentTracer ->
  // liveWorkflowStore -> /api/live-workflows) is the only channel from the live server
  // process out to an offline investigation script; nothing else persists it.
  const diag = plan._meta?.diagnostics ?? null;
  // diagnostic end
  incidentTracer?.step('planner', {
    plan_summary: plan.steps.map(s => s.command || s.action).join(' → '),
    step_count:   plan.steps.length,
    needs_approval: plan.steps.some(s => s.risk === 'high' || s.risk === 'critical'),
    has_rollback:   plan.steps.some(s => s.reversible),
    // DIAGNOSTIC fields (see above) — noop_origin is 'submitted' (deliberate),
    // 'low_confidence' | 'max_iterations' | 'llm_error' | 'llm_circuit_open' |
    // 'planning_exception' (all fallback:_fallbackPlan/_lowConfidencePlan), or null if
    // this ran before the diagnostic instrumentation existed.
    noop_origin:      diag?.stopReason ?? null,
    planner_input:    diag?.plannerInput ?? null,
    tools_available:  diag?.toolsAvailable ?? null,
    last_error:       diag?.lastError ?? diag?.lastSchemaError ?? null,
    // DIAGNOSTIC — plan._meta's own per-iteration record (see planner.js:391), never
    // persisted anywhere before now; this trace pipe is the only channel out of the live
    // process, so without this a capped run's exact per-turn tool-call sequence is lost
    // the moment the process moves on.
    tool_call_log:    plan._meta?.toolCallLog ?? null,
    turns_used:       plan._meta?.turnsUsed ?? null,
  }, {
    resources: [...new Map(items.map(i => [i.key, { ...resourceFromIssue(i.issue), issueKey: i.key }])).values()],
  });

  // §Fix-NoopEscalation (2026-09-04) — an all-noop plan (no automated fix available, or
  // confidence too low to plan at all) routes straight to 'reflexion' (see
  // routeAfterPlanner below), which NEVER passes through policyNode — the only place
  // shouldEscalate()/escalationStore.escalate() were ever called. Confirmed live: a
  // chronically low-confidence incident (e.g. genuinely un-kubectl-fixable cluster
  // infra) just re-investigates from scratch every cooldown window forever, never
  // reaching a human. Apply the identical MAX_FIX_ATTEMPTS gate here too, so this path
  // escalates instead of retrying indefinitely once attempts are exhausted.
  const allNoop = items.every(i => !i.step.command);
  if (allNoop) {
    if (shouldEscalate(attempt)) {
      const uniqueIssues = _uniqueIssues(items);
      console.warn(`[${clusterNames.join(',')}] [GRAPH] planner — no automated fix available + attempts exhausted (${attempt}) → escalating instead of retrying: ${uniqueIssues.map(_issueKey).join(', ')}`);
      await Promise.all(uniqueIssues.map(issue => escalationStore.escalate(_issueKey(issue), issue, [], rca)));
      tracer?.recordEscalation(uniqueIssues.length);
      // §Fix-EscalationReason (2026-09-11) — diag?.stopReason (already computed above,
      // see the "DIAGNOSTIC" block) distinguishes a deliberate no-fix-exists decision
      // ('submitted') from the planner having given up (max_iterations/planning_exception/
      // llm_error/…) — both used to write this exact same generic note, making them
      // indistinguishable downstream. Only this branch's note changes; the other 4
      // escalation sites (DELEGATE_HUMAN, REJECT, policy-rejected, unresolved-after-
      // execution) already carry accurate, non-conflated reasons of their own.
      const noteText = diag?.stopReason === 'submitted'
        ? `escalated after ${MAX_FIX_ATTEMPTS} attempt(s) — no automated fix available`
        : `escalated after ${MAX_FIX_ATTEMPTS} attempt(s) — planner failure (${diag?.stopReason ?? 'unknown'})`;
      uniqueIssues.forEach(issue => {
        const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
        issueTrackerStore.track(_issueKey(issue), { stage: 'escalated', cluster: issue.clusterName, tier, issue, workflowId, note: noteText });
      });
      return { plan, items, outcome: 'escalated' };
    }

    // §Fix-NoopDeadEnd (2026-09-14) — an all-noop plan on a NON-final attempt used to
    // route straight to reflexion (see routeAfterPlanner), which can neither escalate
    // (reflexionNode's escalate check requires actionableSteps.length > 0, never true when
    // executor never ran) nor retry (needs blockReason) — it just silently resolved
    // "failed" in Mongo and wouldn't get another real look until the NEXT independent
    // fleet-cycle redetection, ~minutes later, with no escalation in between. Confirmed
    // live: a genuinely fixable issue (bad nodeSelector) dead-ended this way twice, ~15
    // minutes apart, before making any real progress. Loop back to investigator instead —
    // same blockReason convention routeAfterPolicy/routeAfterExecutor already use for
    // their own retry loops — so a retry happens immediately within this workflow, and
    // the escalation above actually fires after MAX_FIX_ATTEMPTS real attempts instead of
    // after that many widely-spaced partial ones.
    const noteText = diag?.stopReason === 'submitted'
      ? `planner found no automated fix on attempt ${attempt}/${MAX_FIX_ATTEMPTS}`
      : `planner failure on attempt ${attempt}/${MAX_FIX_ATTEMPTS} (${diag?.stopReason ?? 'unknown'})`;
    console.warn(`[${clusterNames.join(',')}] [GRAPH] planner — ${noteText}, re-investigating instead of dead-ending`);
    return { plan, items, blockReason: noteText, lastAttemptFailure: noteText };
  }

  return { plan, items };
}

async function guardianNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, attempt, rca, podLogsByKey, workflowId } = state;

  // §3.4/§3.7 — Guardian consults Reflexion for rules/history too, not just
  // Investigator: fetched once per distinct issue TYPE present in the group (not once
  // per item) since the fingerprint/rules lookup is per-type, mirroring investigator.js's
  // own distinctTypes pattern above in investigatorNode.
  const distinctTypes = [...new Set(items.map(i => i.issue.type))];
  const reflexionByType = new Map(await Promise.all(distinctTypes.map(async issueType => {
    const rep = items.find(i => i.issue.type === issueType).issue;
    const { tier } = _clusterFor(clusterConfigs, rep.clusterName);
    const fingerprint = _fingerprint(rep, tier);
    const queryText = `${rep.type} ${rep.podName ?? rep.nodeName ?? ''} ${rep.namespace ?? ''}`.trim();
    const ctx = await reflectionClient.getContext({ fingerprint, queryText, issueType })
      .catch(() => ({ rules: [], structuralMatches: [], semanticMatches: [] }));
    return [issueType, ctx];
  })));

  // Fetch each distinct (cluster, namespace) pair's pod list once, not once per item —
  // dispatch is namespace-grouped fleet-wide now, so a multi-step plan commonly has
  // several items in the same namespace NAME across DIFFERENT clusters — a namespace-
  // only cache key would silently serve cluster-A's pods to a cluster-B item, so the
  // cache key must be the composite pair, not the namespace alone.
  const nsClusterPairs = [...new Set(
    items.filter(i => i.issue.podName).map(i => `${i.issue.clusterName}::${i.issue.namespace ?? 'default'}`)
  )];
  const podsByClusterNs = new Map(await Promise.all(nsClusterPairs.map(async pairKey => {
    const [clusterName, ns] = pairKey.split('::');
    const { context } = _clusterFor(clusterConfigs, clusterName);
    // A null context means clusterName didn't resolve against the real fleet map (see
    // _clusterFor) — never attempt a kubectl call with an unresolved/untrusted context;
    // just skip the live-state re-fetch for this pair (stateDrift below stays false).
    if (!context) return [pairKey, null];
    try { return [pairKey, await k8sRead.getPods({ namespace: ns, context, asJson: true })]; }
    catch { return [pairKey, null]; } // best-effort only
  })));

  const updated = await Promise.all(items.map(async (item, itemIndex) => {
    if (!item.step.command) return item; // no command → nothing for Guardian to review

    const guardianStartedAt = Date.now();
    const { issue, step } = item;
    const podLogs = podLogsByKey[item.key] ?? '';
    const diagnosis = { rootCause: step.reason, action: step.action, command: step.command, risk: step.risk.toUpperCase(), rationale: step.reason };

    const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
    const reflexionContext = reflexionByType.get(issue.type);
    const result = await guardianClient.review(
      { clusterName: issue.clusterName, tier, review: { issue, diagnosis, podLogs, attempt, rca, reflexionContext: reflexionContext ?? null } },
      { taskId: `${workflowId}:review:${attempt}:${itemIndex}`, workflowId },
    ).catch(err => require('../agents/guardianAgent')._guardianFailureVerdict(
      `Guardian was unavailable (${err.message}) — escalated to a human rather than auto-approved.`));

    // §7.5 — independent re-fetch of live state before judging, so Guardian isn't
    // reviewing the exact same snapshot the Planner already reasoned over.
    let stateDrift = false;
    const driftNotes = [];
    let looksHealthyNow = false;
    // §Fix-TargetGone — distinct from looksHealthyNow below, which requires the pod to
    // still EXIST (just healthy). This is "there is nothing left to act on at all":
    // confirmed live (found investigating a stale-namespace report, 2026-09-09) — a
    // namespace deleted after its incident was classified and queued left the pipeline
    // with no deterministic stopping condition. podsByClusterNs is null only when the
    // live re-fetch itself FAILED (kubectl/API error — see the `catch` below where it's
    // populated) — that's "unknown", never treated as evidence of anything. A non-null
    // result with the pod simply absent from `.items` means the re-fetch SUCCEEDED and
    // the pod genuinely isn't there — most commonly because the whole namespace was
    // deleted out from under an in-flight incident, but works identically for a pod
    // deleted individually.
    let targetConfirmedGone = false;
    if (issue.podName) {
      const pods = podsByClusterNs.get(`${issue.clusterName}::${issue.namespace ?? 'default'}`);
      const live = (pods?.items ?? []).find(p => p.metadata?.name === issue.podName);
      if (pods && !live) {
        targetConfirmedGone = true;
        stateDrift = true;
        driftNotes.push('pod no longer exists in the live cluster (namespace or pod deleted since this incident was detected)');
      }
      const containerStatuses = live?.status?.containerStatuses ?? [];
      // Max across containers, not index 0 — issue.restartCount may reflect whichever
      // container the Orchestrator's classification actually keyed off of, and a
      // multi-container pod's crashing container isn't necessarily index 0.
      const liveRestarts = containerStatuses.length
        ? Math.max(...containerStatuses.map(cs => cs.restartCount ?? 0))
        : null;
      if (liveRestarts != null && liveRestarts !== issue.restartCount) {
        stateDrift = true;
        driftNotes.push(`restartCount was ${issue.restartCount}, is now ${liveRestarts}`);
      }

      // §Fix-1c — restartCount alone misses "the pod already recovered without its
      // restart count moving" (e.g. a container that completed cleanly and is now
      // Ready). Confirmed live (2026-08-28): a pod that had already recovered — Running,
      // every container Ready, nothing waiting/terminated — still got "fixed" because
      // restartCount alone hadn't changed, so stateDrift never fired to flag it.
      const livePhase = live?.status?.phase;
      const allReady = containerStatuses.length > 0 && containerStatuses.every(cs => cs.ready === true);
      const anyWaitingOrTerminated = containerStatuses.some(cs => cs.state?.waiting || cs.state?.terminated);
      looksHealthyNow = (livePhase === 'Running' || livePhase === 'Succeeded') && allReady && !anyWaitingOrTerminated;
      if (looksHealthyNow) {
        stateDrift = true;
        driftNotes.push(`pod is currently ${livePhase} with every container ready — looks healthy now, doesn't match a still-failing pod`);
      }
    }

    // §Fix-P8 (deterministic override, 2026-08-28) — across three independent 20-incident
    // test runs, Guardian's own prompt rule ("REJECT any mutating command against a
    // confirmed-healthy target") did not hold: it correctly flags looksHealthyNow/
    // stateDrift and then still approves or MODIFYs a softer mutating command anyway
    // ("a restart won't hurt"). looksHealthyNow above is itself a deterministic,
    // kubectl-sourced fact (not a model judgment), so enforce the rule in code instead of
    // trusting the prompt to hold: a confirmed-healthy target overrides whatever verdict
    // Guardian returned, for any command it approved or modified. DELEGATE_HUMAN and
    // REJECT are left alone — nothing to override, Guardian already reached the right
    // place by a different reason.
    if (looksHealthyNow && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} overriding verdict=${result.verdict} → REJECT: live state shows the target is already healthy, refusing to run a mutating command against it regardless of Guardian's own reasoning`);
      result.reason = `Overridden by deterministic live-health check — target is currently healthy, so no mutating command should run. Guardian's own verdict was ${result.verdict} (${result.reason})`;
      result.verdict = 'REJECT';
      result.classification = 'SAFE'; // declining an unnecessary action is the safe outcome here, not a risky one
      result.suggestedCommand = null;
    }

    // §Fix-TargetGone (deterministic override, 2026-09-09) — same reasoning/placement as
    // §Fix-P8 above: a confirmed-absent target overrides whatever verdict Guardian
    // returned, for any command it approved or modified, so a queued/in-flight incident
    // for a namespace that was deleted mid-run can never get a mutating command executed
    // against it. Checked independently of looksHealthyNow (that one needs live pod data
    // to compute allReady/anyWaitingOrTerminated; this one is exactly the case where none
    // of that data exists because the pod itself is gone).
    if (targetConfirmedGone && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} overriding verdict=${result.verdict} → REJECT: live state confirms the target pod no longer exists, refusing to run a mutating command against it regardless of Guardian's own reasoning`);
      result.reason = `Overridden by deterministic live-state check — target pod no longer exists (namespace or pod deleted since this incident was detected), nothing to fix. Guardian's own verdict was ${result.verdict} (${result.reason})`;
      result.verdict = 'REJECT';
      result.classification = 'SAFE';
      result.suggestedCommand = null;
    }

    // §Fix-RootCauseGate (2026-08-31) — deterministic override, same pattern as §Fix-P8
    // above: runs regardless of Guardian's verdict (even an APPROVE), since the
    // rootCause/action mismatch is a fact about the diagnosis and the command, not
    // something that depends on what Guardian happened to say about it.
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

    // §Fix-RootCauseFitExperiment (Phase 4, 2026-09-18) — ADVISORY ONLY, per the
    // architecture review's experiment design (see rootCauseFitAssessor.js's header):
    // runs a real LLM judgment on the same question the regex above answers
    // deterministically, purely to collect comparison data. Never reassigns `result` —
    // this line intentionally comes AFTER every deterministic override above (§Fix-P8,
    // §Fix-TargetGone, the regex), so nothing here can influence any of them. Skipped
    // whenever there's no command to assess (a noop step) OR the verdict is already
    // REJECT/DELEGATE_HUMAN from ANY of those prior overrides — nothing useful to
    // compare against an outcome that's already decided, and no reason to spend an
    // LLM call collecting data for a case that's already fully handled.
    let rootCauseFitAdvisory = null;
    if (step.command && result.verdict !== 'REJECT' && result.verdict !== 'DELEGATE_HUMAN') {
      rootCauseFitAdvisory = await assessRootCauseFit({
        rootCause: investigatedRootCause, command: step.command, evidenceSummary: issue.evidenceSummary,
      }).catch(err => ({ fit: 'UNCERTAIN', reason: `advisory call threw: ${err.message}`, evidenceCited: [] }));
      console.log(`[${issue.clusterName}] [GRAPH] guardian — ${item.key} root-cause-fit advisory (NOT enforced): fit=${rootCauseFitAdvisory.fit} — ${rootCauseFitAdvisory.reason}`);
    }

    // §Fix-P10 (2026-08-28) — Guardian repeatedly asserts a condition has CHANGED
    // ("the outage has been resolved") with nothing in evidenceCited backing it up. Can't
    // safely auto-REJECT this the way P8 does above (the claim might be true), so instead
    // force a human-approval gate whenever the reason makes this kind of claim without
    // citing anything — same spirit as the existing RISKY/DANGEROUS approval gate, just
    // triggered by an ungrounded-claim pattern instead of a risk classification.
    const assertsUngroundedResolution = RESOLUTION_CLAIM_PATTERN.test(result.reason || '')
      && (!result.evidenceCited || result.evidenceCited.length === 0);
    if (assertsUngroundedResolution) {
      result.reason = `${result.reason} [flagged: asserts a status change with no evidenceCited to support it — routed for mandatory approval instead of auto-executing]`;
    }

    // §7.2 — a handoff that fails schema validation must escalate, not silently proceed
    // (or, worse, throw uncaught: GuardianVerdictSchema.parse() throws on a mismatch, and
    // an uncaught throw here would abort the whole runWorkflow() promise — dropping the
    // incident from issueTrackerStore/escalationStore entirely instead of surfacing it).
    // guardianAgent.js already sanitizes verdict/classification/suggestedCommand/confidence
    // against known-valid sets before returning, so this should be rare in practice — but
    // "rare" isn't "impossible", and this is exactly the boundary the principle protects.
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
      // Phase 4 experiment data (see rootCauseFitAssessor.js) — advisory only, not
      // read by any routing/decision code; recorded here purely so a future review of
      // this experiment can pull real (regex-verdict, LLM-verdict, actual-outcome)
      // triples out of WorkflowTrace/IncidentTracer history instead of starting from zero.
      rootCauseFitAdvisory: rootCauseFitAdvisory,
    }, { resources: [{ ...resourceFromIssue(issue), issueKey: item.key }], durationMs: Date.now() - guardianStartedAt });

    // investigatedRootCause carried through on the item itself (not just used locally
    // above) so the Executor can re-run the identical §Fix-RootCauseGate check against
    // whatever command ACTUALLY ends up executing (see §Fix-ExecutorHonesty below) —
    // Guardian's MODIFY can substitute a different command than the one checked here.
    return { ...item, diagnosis, verdict, investigatedRootCause };
  }));

  return { items: updated };
}

// Deterministic Policy node — reuses PolicyEngine per STEP (RiskEngine retired from
// this pipeline, see §Fix-RiskEngineRetirement above; the legacy clusterAgent.js
// pipeline still uses both), positioned after Guardian per architecture-doc order
// (Planner → Guardian → Policy → Executor).
//
// Merge rule (§Fix-5, revised 2026-08-28): a Guardian REJECT blocks only the STEPS
// belonging to an issue that has NO surviving (APPROVE/MODIFY) step left — an issue
// with at least one surviving step just drops its rejected step(s) and proceeds with
// the rest. Confirmed live: a node incident's plan (cordon + drain) escalated after 3
// full re-diagnose attempts even though Guardian approved "cordon" every single time —
// the always-rejected "drain" step dragged the approved "cordon" step down with it
// under the old any-REJECT-blocks-the-whole-plan rule. Policy's OWN rejections
// (validateCommand/validateNodeCommand below) still block the whole plan as before —
// that part intentionally isn't touched by this change, since Policy's structural
// checks are meant to be a hard, group-wide gate, not a per-step judgment call the way
// Guardian's is.
async function policyNode(state, config) {
  const tracer         = config?.configurable?.tracer;
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, attempt, rca, workflowId } = state;

  // DELEGATE_HUMAN (architecture-doc §3.4's 4th verdict) escalates IMMEDIATELY — unlike
  // REJECT, Guardian is explicitly saying no available automated action can fix this, so
  // looping back through another investigate/plan attempt (shouldEscalate's normal
  // MAX_FIX_ATTEMPTS gate) would just waste a cycle re-deriving the same conclusion.
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
    // If EVERY step of some issue got rejected, there's nothing left of that issue's
    // plan to partially execute — and splitting "these issues proceed, that one
    // re-diagnoses" within a single graph-state transition needs a bigger state-model
    // change than this fix is scoped for. Fall back to the original whole-group
    // behavior for exactly that case; the step-level split below only applies when
    // every issue in the group has at least one surviving step.
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
      // lastAttemptFailure (§Fix-RetryContext) carries the rejected command itself, not
      // just the reason — blockReason alone (Guardian's reason text) is what routing and
      // the older callers still read; this richer note is what the NEXT investigator/
      // planner call actually sees so it can avoid re-proposing the same command.
      return {
        blockReason: rejectedByGuardian.verdict.reason,
        lastAttemptFailure: `Guardian rejected "${rejectedByGuardian.step.command || rejectedByGuardian.step.action}": ${rejectedByGuardian.verdict.reason}`,
      };
    }

    console.warn(`[GRAPH] policy — dropping ${rejectedItems.length} Guardian-rejected step(s), proceeding with the rest of the plan: ${rejectedItems.map(i => `${i.key} (${i.step.command || i.step.action}): ${i.verdict.reason}`).join(' | ')}`);
  }

  // Every issue in the group has at least one surviving step — rejected steps are
  // simply dropped from here on (never reach Policy/Executor, never appear in the
  // returned `items`); reflexionNode and issueTrackerStore only see the steps that
  // actually ran, same as they always have for a `noop` step.
  const survivingItems = items.filter(i => i.verdict?.verdict !== 'REJECT');

  const validated = survivingItems.map(item => {
    if (!item.step.command) return item; // no command — nothing for Policy to gate

    // GuardianVerdictSchema.suggestedCommand is nullable — a MODIFY verdict with no
    // suggestedCommand falls back to the Planner's original command rather than feeding
    // `null` into PolicyEngine.validateCommand() (which would only surface as a
    // confusing POLICY_EMPTY_COMMAND rejection instead of a clear signal that Guardian's
    // response was incomplete).
    const finalCommand = (item.verdict.verdict === 'MODIFY' && item.verdict.suggestedCommand)
      ? item.verdict.suggestedCommand
      : item.step.command;
    const isNodeScope  = item.step.target.kind === 'Node';
    const { tier } = _clusterFor(clusterConfigs, item.issue.clusterName);
    // Same controller-identity fields the legacy validate() context used, just renamed
    // to what validateCommand()/validateNodeCommand() actually read (hasController/
    // ownerKind — see policyEngine.js's v5 COMMAND GATE section for why).
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

    // PolicyEngine has no separately-named rbac/quota/denylist checks in the v5 command
    // path — it's one structural pass/fail (`status`) with a `blockedRules` list of the
    // specific rule codes that fired (e.g. POLICY_PROD_DELETE, POLICY_BLAST_RADIUS_FLOOR).
    // Reporting that directly rather than inventing rbac/quota/denylist booleans that
    // don't correspond to anything PolicyEngine actually computes.
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
    if (!item.policyResult) return item; // no command

    // §Fix-RiskEngineRetirement — this used to ALSO run the command through a second,
    // independent risk formula (RiskEngine.calculateRisk, fed by a regex-guessed
    // command category) whose BLOCK verdict could force `risk` to HIGH on top of
    // whatever this call already produced — see the file-header comment on why that
    // was retired as redundant, with its one real safety property (drain is always
    // HIGH) moved into this same function's own floor instead.
    let risk = item.step.risk.toUpperCase();
    const riskOverride = policyEngine.evaluateRiskOverridesForCommand({ ...item.policyPlan, command: item.policyResult.command }, item.policyCtx);
    if (riskOverride.forceApproval || riskOverride.risk !== risk) risk = riskOverride.risk;

    return { ...item, risk, finalStep: { ...item.step, command: item.policyResult.command } };
  });

  // One approval request per step that needs it — sequential (rare: HIGH risk,
  // non-reversible, or Guardian itself flagged it). Any denial blocks the whole plan,
  // same conservative merge rule.
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

// Abort markers for _executeIssueSteps — a no-op with in-process k8s-write, whose
// executor is never resumed (see _resumeDecision). A marker that can't be written or read
// is logged, not fatal: with Redis unreachable the remote k8s-write calls fail anyway.
async function _setAbortMarker(name) {
  if (k8sWrite.mode !== 'remote') return;
  try { await (await getBus()).setMarker(name); }
  catch (err) { console.error(`[GRAPH] executor — could not record abort marker ${name}: ${err.message}`); }
}

async function _hasAbortMarker(name) {
  if (k8sWrite.mode !== 'remote') return false;
  try { return await (await getBus()).hasMarker(name); }
  catch (err) {
    console.error(`[GRAPH] executor — could not read abort marker ${name}: ${err.message}`);
    return false;
  }
}

// Best-effort undo of every already-applied step in this issue's plan, most-recent
// first — shared by both failure paths in _executeIssueSteps below (a thrown command
// error, and a command that ran but didn't verify healthy): a failed rollback is
// logged, not retried, the operator needs to know rather than have the agent loop on it.
async function _rollback(succeeded) {
  for (const s of [...succeeded].reverse()) {
    if (!s.step.reversible || !s.step.inverseCommand) {
      console.warn(`[${s.item.issue.clusterName}] [GRAPH] executor — cannot roll back "${s.step.command}" for ${s.item.key}: step was not marked reversible`);
      continue;
    }
    try {
      // Own deterministic task id, so a redelivered rollback replays instead of undoing twice.
      await k8sWrite.apply(
        { step: { command: s.step.inverseCommand, target: s.step.target }, context: s.context },
        { taskId: `${s.taskId}:rollback`, workflowId: s.workflowId },
      );
      console.warn(`[${s.item.issue.clusterName}] [GRAPH] executor — rolled back "${s.step.command}" via "${s.step.inverseCommand}" for ${s.item.key}`);
    } catch (rbErr) {
      console.error(`[${s.item.issue.clusterName}] [GRAPH] executor — ROLLBACK FAILED for ${s.item.key} (undo of "${s.step.command}" via "${s.step.inverseCommand}"): ${rbErr.message}`);
    }
  }
}

// Execute one issue's steps IN THE PLANNER'S DECLARED ORDER (e.g. cordon -> drain ->
// patch -> uncordon) and stop at the first failure — running them concurrently would
// defeat the ordering the Planner explicitly chose (architecture-doc §3.3: "an ORDERED
// SEQUENCE of steps... reflecting how real remediations actually work"). On failure,
// §7.7's rollback semantics become real here: previously-succeeded steps IN THIS SAME
// GROUP are undone via their own declared inverseCommand, most-recent first, best-effort
// (a failed rollback is logged, not retried — the operator needs to know, not have the
// agent loop on it). Steps after the failure point are never attempted.
async function _executeIssueSteps(group, clusterConfigs, workflowId, incidentTracer, attempt = 0) {
  const succeeded = []; // steps actually applied this run, oldest first — reversed for rollback
  const finished  = [];
  let aborted = false;

  // Resume safety (remote k8s-write only — the one mode _resumeDecision resumes the
  // executor in). Per-step replay alone can't express "this plan already failed and was
  // rolled back": an applied step's cached success would replay although it was undone,
  // and the failed step's short-lived failure cache would let it re-run for real — on
  // top of a state that matches neither the plan nor the rollback. So the abort itself is
  // recorded durably, BEFORE rolling back, and a resumed run checks it first.
  const abortMarker = `${workflowId}:apply:${group[0].key}:${attempt}:aborted`;
  const abortAndRollback = async () => {
    aborted = true;
    await _setAbortMarker(abortMarker);
    await _rollback(succeeded);
  };

  // Pushes to `finished` AND emits the matching {action, status} trace line for that
  // step in one place, so every exit path (skipped/blocked/fixed) is covered without
  // repeating the resource-lookup boilerplate at each call site.
  const pushFinished = (item, executionOutcome, rest = {}) => {
    const entry = { ...item, executionOutcome, ...rest };
    finished.push(entry);
    const finalStep = item.finalStep ?? item.step;
    incidentTracer?.step('executor', {
      action: finalStep.command || finalStep.action, status: executionOutcome,
      // Was silently dropped before — a 'blocked' outcome traced with no reason defeats
      // the whole point of this tracer (found live, 2026-09-09:
      // a blocked executor step showed up in the dashboard with nothing explaining why,
      // even though graph.js's own catch block already had err.message in hand).
      ...(rest.executionError ? { reason: rest.executionError } : {}),
      ...(rest.executionNote  ? { note: rest.executionNote }   : {}),
    }, { resources: [{ ...resourceFromIssue(item.issue), issueKey: item.key }] });
    return entry;
  };

  if (await _hasAbortMarker(abortMarker)) {
    console.warn(`[${group[0].issue.clusterName}] [GRAPH] executor — ${group[0].key}'s plan (attempt ${attempt}) was aborted and rolled back before an orchestrator restart; not re-applying it`);
    for (const item of group) {
      if (!item.step.command) pushFinished(item, 'skipped');
      else pushFinished(item, 'blocked', { executionError: 'plan was aborted and rolled back before an orchestrator restart — not re-applied on resume' });
    }
    return finished;
  }

  for (const [stepIndex, item] of group.entries()) {
    if (aborted) {
      pushFinished(item, 'skipped', { executionError: 'aborted — an earlier step in this issue\'s plan failed' });
      continue;
    }
    if (!item.step.command) { pushFinished(item, 'skipped'); continue; }

    const step = item.finalStep ?? item.step;
    // item.issue.clusterName is the primary source (traces back through _findClusterMismatches'
    // ground-truth cross-check in orchestratorAgent.js); item.step.clusterName is a secondary/
    // audit value attached by plannerNode from the same issue — they should always agree, so a
    // disagreement here is a real signal something desynced upstream, not just cosmetic.
    if (step.clusterName && step.clusterName !== item.issue.clusterName) {
      console.warn(`[GRAPH] executor — step.clusterName ("${step.clusterName}") disagrees with issue.clusterName ("${item.issue.clusterName}") for ${item.key}; using issue.clusterName`);
    }
    const { context } = _clusterFor(clusterConfigs, item.issue.clusterName);
    issueTrackerStore.track(item.key, { stage: 'approved', cluster: item.issue.clusterName, tier: _clusterFor(clusterConfigs, item.issue.clusterName).tier, issue: item.issue, workflowId, note: `executing: ${step.command}` });

    // A null context means item.issue.clusterName didn't resolve against the real fleet
    // map (see _clusterFor) — never attempt a kubectl call with an unresolved/untrusted
    // context, even one PolicyEngine would otherwise simulate; refuse outright instead.
    if (!context) {
      console.error(`[GRAPH] executor — refusing to execute for ${item.key}: cluster "${item.issue.clusterName}" is not a known cluster`);
      pushFinished(item, 'blocked', { executionError: `unknown cluster "${item.issue.clusterName}"` });
      aborted = true;
      continue;
    }

    try {
      // Deterministic task id (workflow + issue + attempt + step position): if this
      // request is redelivered, or re-sent after an orchestrator restart, the k8s-write
      // gateway replays the stored result instead of applying the step a second time.
      const taskId = `${workflowId}:apply:${item.key}:${attempt}:${stepIndex}`;
      await k8sWrite.apply({ step, context }, { taskId, workflowId });
      succeeded.push({ item, step, context, taskId, workflowId });

      // §Fix-ExecutorHonesty (2026-08-31) — a successful kubectl exit code only proves
      // the command RAN, not that it resolved anything; "fixed" was being applied to
      // both meanings interchangeably. First, the cheap deterministic pre-filter
      // §Fix-RootCauseGate already applied in guardianNode, re-run here against
      // `step.command` — the command that ACTUALLY executed here, which can differ from
      // what Guardian originally reviewed if a MODIFY verdict substituted a different
      // one. Belt-and-suspenders: guardianNode's gate should already have rejected
      // anything this catches, this is the backstop for the case where it didn't (a
      // REJECT that got downgraded per-issue in policyNode's step-level merge, a
      // substituted MODIFY command, or simply this regex missing a phrasing variant
      // there but not here).
      const unverifiedReason = _actionCannotAddressRootCause({
        rootCause: item.investigatedRootCause,
        evidenceSummary: item.issue.evidenceSummary,
        command: step.command,
      });

      // §Fix-LiveVerification (2026-09-11) — the text-pattern check above can only ever
      // catch an obviously-wrong command; it never re-checked the cluster. In dry-run
      // mode nothing real ran, so there's nothing to re-check — keep the old
      // text-pattern-only behavior there. Otherwise, actually poll the target resource
      // for real health before calling this "fixed".
      let healthy = true, healthReason = unverifiedReason;
      if (!unverifiedReason && !policyEngine.dryRunMode) {
        const verification = await k8sRead.verifyHealth({ step, issue: item.issue, context });
        healthy = verification.healthy;
        healthReason = verification.reason;
      } else if (unverifiedReason) {
        healthy = false;
      }

      if (healthy) {
        pushFinished(item, 'fixed');
      } else {
        // A step that ran but didn't verify healthy is exactly as much "this plan
        // didn't work" as a thrown command error — abort and roll back the rest of
        // this issue's steps the same way, rather than blindly continuing to e.g.
        // "uncordon" a node whose preceding "cordon" never actually verified.
        console.warn(`[${item.issue.clusterName}] [GRAPH] executor — ${item.key} ran "${step.command}" but it did not verify as fixed: ${healthReason}`);
        pushFinished(item, 'blocked', { executionError: healthReason });
        await abortAndRollback();
      }
    } catch (err) {
      console.error(`[${item.issue.clusterName}] [GRAPH] executor failed for ${item.key} (${step.command}): ${err.message}`);
      pushFinished(item, 'blocked', { executionError: err.message });
      await abortAndRollback();
    }
  }

  return finished;
}

// Shared by executorNode (decides whether to loop back for another attempt) and
// reflexionNode (decides whether to finally escalate) — both need the identical answer
// to "is this issue actually resolved", so there is one definition instead of two that
// could silently drift apart (see the 2026-08-26 bug this exact logic was already fixed
// for once: grabbing steps[0]'s outcome instead of requiring every actionable step to
// have succeeded).
function _issueResolution(steps) {
  const actionableSteps = steps.filter(s => s.executionOutcome && s.executionOutcome !== 'skipped');
  const resolved = actionableSteps.length > 0 && actionableSteps.every(s => s.executionOutcome === 'fixed');
  return { actionableSteps, resolved };
}

async function executorNode(state, config) {
  const incidentTracer = config?.configurable?.incidentTracer;
  const { clusterConfigs, items, workflowId, attempt } = state;

  // Steps for the SAME issue must run in the Planner's declared order and share
  // rollback on failure (see _executeIssueSteps); steps for DIFFERENT issues target
  // unrelated resources and stay independent, so their groups still run concurrently —
  // one issue's failure must not block or delay an unrelated issue's fix.
  const byIssue = new Map();
  for (const item of items) {
    if (!byIssue.has(item.key)) byIssue.set(item.key, []);
    byIssue.get(item.key).push(item);
  }

  const grouped = await Promise.all(
    [...byIssue.values()].map(group => _executeIssueSteps(group, clusterConfigs, workflowId, incidentTracer, attempt))
  );
  const results = grouped.flat();

  // A whole ISSUE's plan failing doesn't stop another issue's plan in the same group —
  // they may target different resources, so one failure shouldn't block unrelated fixes.
  const actionable = results.filter(r => r.executionOutcome !== 'skipped');
  const outcome = actionable.length === 0 || actionable.some(r => r.executionOutcome === 'fixed')
    ? 'fixed'
    : 'blocked';

  // One "final ready state" summary line per issue, on top of _executeIssueSteps' own
  // per-step {action, status} lines above — this is the row `trace pod`/`trace incident`
  // renders as the executor's overall ready=<bool> for that issue's plan.
  //
  // §Fix-RetryLoop (2026-09-11) — also decide HERE whether any issue needs another real
  // attempt: an issue whose fix didn't verify used to just fall through to reflexion/END
  // and wait on the external ~30s poll cycle to maybe redetect and redispatch it later.
  // Loop back to investigator for a genuine re-diagnosis instead, within THIS run, the
  // same way routeAfterPolicy already does for a Guardian REJECT — up to
  // MAX_FIX_ATTEMPTS real tries before reflexionNode gives up and escalates.
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
    // §Fix-RetryContext (2026-09-14) — richer than blockReason: includes the actual
    // command that was tried, not just why it failed, so the next planner call (see
    // plannerNode's lastAttemptFailure read) can tell a retry apart from a fresh guess and
    // actually avoid repeating it. Confirmed live: mk-overscaled retried the identical
    // insufficient `--replicas=24` twice in the same escalation cycle with no adjustment,
    // because the planner never knew that exact command had already been tried and failed.
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

  // Reflect once per DISTINCT issue, not per step — several steps can share one issue
  // (e.g. cordon+drain+uncordon all belong to the same node incident).
  const byIssue = new Map();
  for (const item of items) {
    if (!byIssue.has(item.key)) byIssue.set(item.key, { issue: item.issue, steps: [] });
    byIssue.get(item.key).steps.push(item);
  }

  await Promise.all([...byIssue.entries()].map(async ([key, { issue, steps }]) => {
    // Every ACTIONABLE step for this specific issue must have succeeded, not just the
    // first one found — `steps.find(s => s.executionOutcome)` used to just grab the
    // first step, and since executor.js always sets a truthy executionOutcome
    // (skipped/fixed/blocked all truthy), that degenerated to "steps[0]'s outcome" for
    // every multi-step issue (e.g. a node's cordon→drain→uncordon plan), marking an
    // issue resolved off its FIRST step succeeding even if a later step failed (found
    // in review, 2026-08-26).
    const { actionableSteps, resolved } = _issueResolution(steps);
    let itemOutcome = actionableSteps.length === 0 ? (outcome ?? 'failed') : (resolved ? 'fixed' : 'blocked');

    // §Fix-RetryLoop (2026-09-11) — routeAfterExecutor (via executorNode's blockReason)
    // only loops back to investigator while attempts remain; once MAX_FIX_ATTEMPTS is
    // used up, THIS is the pass where that unresolved issue finally lands, and previously
    // nothing escalated it — it would just sit at 'blocked' and get redetected/retried
    // forever on the external ~30s poll cycle with no cap. Escalate here using the exact
    // same pattern plannerNode/policyNode already use for their own escalation paths
    // above (REJECT/DELEGATE_HUMAN/no-automated-fix) — this is that same gate, just for
    // "genuinely tried MAX_FIX_ATTEMPTS times and it never verified fixed".
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

    // Read here, not inside reflect(): overrideStore is in-memory in THIS process. Only
    // peeked — it's consumed below once the episode carrying it is actually stored, so a
    // reflection/remember failure (e.g. a remote timeout) doesn't lose the admin's feedback.
    const overrideData = overrideStore.peekFor(issue);
    const reflection = await reflectionClient.reflect({
      issue, planAction: primaryCommand, rootCauseDiagnosis: rca?.suspected_cause ?? 'unknown',
      timeline: [], resolved, podLogs, rca: rca ?? null, overrideData,
    }, { taskId: `${workflowId}:reflect:${key}`, workflowId }).catch(() => null);

    if (reflection) {
      const { tier } = _clusterFor(clusterConfigs, issue.clusterName);
      const remembered = await reflectionClient.remember({
        fingerprint: _fingerprint(issue, tier),
        context: { issue, podLogsSnippet: podLogs?.slice(-500) ?? '' },
        timeline: steps.map(s => {
          const finalized = s.finalStep ?? s.step;
          return { action: finalized.action, command: finalized.command, outcome: s.executionOutcome ?? itemOutcome, at: new Date() };
        }),
        reflection, resolved, resolvedAction: resolved ? primaryCommand : null,
        totalAttempts: attempt, rca: rca ?? undefined,
      }, { taskId: `${workflowId}:remember:${key}`, workflowId }).then(() => true, () => false);
      if (remembered) overrideStore.consumeFor(issue, overrideData);
      if (!resolved) await ruleEngine.analyze(issue.type).catch(() => {});
    }

    // rca_accuracy has no dedicated field anywhere upstream — ReflectionAgent.reflect()
    // returns {rootCause, lessonsLearned, suggestedRule, confidence}, so `confidence`
    // here is Reflection's own confidence in ITS post-hoc root-cause read, used as the
    // best available proxy for "how accurate was the original RCA" rather than
    // inventing a new metric no agent actually computes.
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

    // Same cross-cycle bookkeeping clusterAgent.js's cooldowns Map used to provide —
    // without this, an unresolved incident gets reclassified and redispatched as a
    // brand-new workflow (fresh attempt:0) on every single orchestrator cycle, forever.
    if (resolved) {
      await shortMemory.resolveIncident(key).catch(() => {});
    } else {
      // §Fix-EscalationSpam — an escalated incident gets a much longer cooldown than a
      // normal in-progress retry, so the automated pipeline doesn't re-escalate the exact
      // same thing every 45s while a human hasn't had a chance to act yet.
      const cooldownMs = itemOutcome === 'escalated' ? ESCALATION_COOLDOWN_MS : COOLDOWN_MS;
      await Promise.all([
        shortMemory.incrementAttempt(key),
        shortMemory.setCooldown(key, cooldownMs),
      ]).catch(() => {});
    }
  }));

  return {};
}

// ── Routing ──────────────────────────────────────────────────────────────
// Phase 2 (Fast Path) — the ONLY consumer of `issues[0].complexity` (see _toIssue's
// comment on where that field used to get silently dropped). Deliberately also checks
// group size, not just the complexity tag: a SIMPLE incident is, by the Orchestrator's
// own classification rule, always dispatched solo — a length>1 group reaching here
// despite a SIMPLE tag indicates the tag shouldn't be trusted for this group, so fail
// safe to the Full Investigator rather than guessing which single issue to hand Fast
// Path (fastPathNode has the identical guard as defense-in-depth, in case this routing
// function is ever bypassed by a future caller).
function routeByComplexity(state) {
  return (state.issues.length === 1 && state.issues[0].complexity === 'SIMPLE') ? 'fastPath' : 'investigator';
}

function routeAfterFastPath(state) {
  return state.fastPathOutcome === 'sufficient' ? 'planner' : 'investigator';
}

function routeAfterPlanner(state) {
  // §Fix-NoopDeadEnd (2026-09-14) — an all-noop plan with attempts remaining now sets
  // blockReason (see plannerNode) to loop back for a real retry, same as a Guardian
  // REJECT or an unresolved execution — only a FINAL attempt's all-noop (which sets
  // outcome:'escalated' instead, never blockReason) or the escalated branch itself falls
  // through to the allNoop check below and routes to reflexion.
  if (state.blockReason) return 'investigator';
  const allNoop = state.items.every(i => !i.step.command);
  return allNoop ? 'reflexion' : 'guardian';
}

function routeAfterPolicy(state) {
  if (state.outcome === 'escalated' || state.outcome === 'blocked') return 'reflexion';
  if (state.blockReason) return 'investigator';
  return 'executor';
}

// §Fix-RetryLoop (2026-09-11) — same blockReason convention routeAfterPolicy already
// uses for the REJECT re-diagnose loop, extended to the execute/verify step: executorNode
// sets blockReason only when some issue didn't verify fixed AND attempts remain.
function routeAfterExecutor(state) {
  return state.blockReason ? 'investigator' : 'reflexion';
}

// Measurement (Phase 1) — wraps a node function with per-node timing recorded onto
// the run's WorkflowTracer (config.configurable.tracer), without changing the node's
// own signature/logic. Durations ACCUMULATE across repeat visits (the investigator<->
// policy re-diagnose loop can visit 'investigator'/'policy' more than once per
// workflow — see WorkflowTracer.endNode), so latency_per_node reflects total time in
// that node across the whole run. `tracer` is optional throughout (config may be
// undefined, e.g. graph.test.js's direct node-function calls) — tracing must never be
// able to affect or break the actual workflow.
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

// ── Build + compile ────────────────────────────────────────────────────────
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

// Compiled once WITHOUT a checkpointer at module load — graph.test.js, LangGraph Studio
// (langgraph.json) and the scripts/ harnesses import this file with no database.
// OrchestratorAgent.start() swaps in the checkpointed compilation via useCheckpointer()
// once MongoDB is reachable (src/orchestrator/checkpointing.js).
const compiledBase = graph.compile();
let compiled     = compiledBase;
let checkpointer = null;

function useCheckpointer(saver) {
  checkpointer = saver ?? null;
  compiled = checkpointer ? graph.compile({ checkpointer }) : compiledBase;
}

const RECURSION_LIMIT = MAX_FIX_ATTEMPTS * 6 + 10; // bound the investigator↔policy re-diagnose loop

// Measurement (Phase 1) — one WorkflowTracer per runWorkflow() call, passed through
// LangGraph's config.configurable (NOT a WorkflowState/Annotation channel — see
// src/monitoring/workflowTracer.js's file header for why). Each concurrent workflow
// (orchestratorAgent.js dispatches up to ISSUE_CONCURRENCY at once) gets its own
// instance here, so there's no shared mutable tracer state across concurrent runs.
function _newWorkflowTracer(workflowId, issues) {
  return new WorkflowTracer({
    workflowId,
    clusters:     [...new Set(issues.map(i => i.clusterName))],
    namespace:    issues[0]?.namespace ?? null,
    incidentType: issues[0]?.type ?? null,
    complexity:   issues.length === 1 ? (issues[0]?.complexity ?? 'UNKNOWN') : 'COMPLEX',
    issueKeys:    issues.map(_issueKey),
    pipeline:     'v5',
  });
}

// Shared by runWorkflow (fresh input) and resumeWorkflow (input = null → LangGraph
// continues the thread from its last checkpoint). thread_id = workflowId is what the
// checkpointer keys on; without a checkpointer it's simply ignored.
async function _invokeWorkflow(input, { workflowId, issues, incidentTracer }) {
  const tracer = _newWorkflowTracer(workflowId, issues);
  const result = await compiled.invoke(input, {
    recursionLimit: RECURSION_LIMIT,
    configurable: { thread_id: workflowId, tracer, incidentTracer },
  });

  tracer.finalize(result.outcome);
  workflowTraceStore.save(tracer.toDocument()).catch(() => {});
  liveWorkflowStore.finish(workflowId, result.outcome);
  // Finished — nothing left to resume. (The collection's TTL index would expire it anyway.)
  checkpointer?.deleteThread(workflowId).catch(() => {});

  return result;
}

// Entry point OrchestratorAgent calls per launched (namespace- or node-)group.
// `incidents` is always an array — one incident for a node-scoped group (size 1
// through the same code path) or several for a namespace group, now possibly spanning
// multiple clusters. `clusterConfigs` is the full fleet map (built once per fleet cycle
// in orchestratorAgent.js — see runWorkflow's callers there), not just the cluster(s)
// obviously present in `incidents` — cheap to pass whole, and a re-diagnose loop could
// otherwise need to resolve a cluster that wasn't in the initial incident list.
async function runWorkflow({ incidents, clusterConfigs, workflowId = randomUUID(), incidentTracer = null }) {
  const issues = incidents.map(_toIssue);
  // Falls back to a fresh IncidentTracer when a caller (e.g. graph.test.js, or a future
  // direct invoke() caller) doesn't pass one — step() is a no-op unless TRACE_ENABLED,
  // so this costs nothing when tracing is off and never changes runWorkflow's behavior.
  const incTracer = incidentTracer ?? new IncidentTracer({ workflowId, resource: resourceFromIssue(issues[0]) });

  // Seed `attempt` from Short Memory's persisted per-issue counter (incrementAttempt()
  // in reflexionNode below already writes this on every unresolved outcome) instead of
  // always starting fresh at 0 — without this, that counter was written every cycle but
  // never read back anywhere, so shouldEscalate()'s MAX_FIX_ATTEMPTS cap only ever
  // applied WITHIN one workflow's own re-diagnose loop, never ACROSS separate dispatches
  // of the same issue after a cooldown — an issue that keeps failing, cooling down, and
  // getting redispatched as a fresh workflow would loop forever and never escalate to a
  // human (found in review, 2026-08-26). Highest count among the group's issues, since
  // one workflow's `attempt` is shared state for the whole group.
  const attemptCounts = await Promise.all(issues.map(i => shortMemory.attemptCount(_issueKey(i))));
  const attempt = Math.max(0, ...attemptCounts);

  // LangGraph JS's Annotation({ default }) is NOT applied to keys simply absent from the
  // initial invoke() input (confirmed directly — an omitted `attempt` key comes through as
  // `undefined`, not the declared default of 0, turning every `attempt + 1` into NaN and
  // silently defeating the shouldEscalate() >= MAX_FIX_ATTEMPTS check). Every state field
  // must be seeded explicitly here rather than relying on the schema defaults.
  return _invokeWorkflow({
    incidents, clusterConfigs, issues, workflowId,
    attempt, rca: null, podLogsByKey: {}, plan: null, items: [], blockReason: null, outcome: null, lastAttemptFailure: null,
  }, { workflowId, issues, incidentTracer: incTracer });
}

// ── Resume after an orchestrator restart ───────────────────────────────────
// Pure decision over a LangGraph state snapshot (graph.getState()) — kept separate so the
// safety rules are unit-testable without a database.
//
//   • no checkpoint / nothing pending  → nothing to resume (it finished, or never started)
//   • interrupted INSIDE the executor  → resume ONLY when k8s-write runs as the remote
//     gateway AND the checkpoint is younger than its idempotency window: LangGraph re-runs
//     an interrupted node from its start, and only the remote gateway's per-task-id
//     done-cache turns a re-sent "apply step N" into a replay instead of a second
//     mutation. In-process execution has no such cache, so re-running could apply a step
//     twice — that case falls back to the pre-existing behavior (the incident is
//     redetected and redispatched as a fresh workflow on a later cycle).
//   • anything else (investigator/planner/guardian/policy/reflexion) re-runs safely: those
//     nodes only read the cluster and call agents.
const EXECUTOR_REPLAY_WINDOW_MS = 55 * 60 * 1000; // inside src/mesh/bus.js's 1h done-cache TTL

function _resumeDecision(snapshot, { k8sWriteMode, now = Date.now() } = {}) {
  if (!snapshot?.values?.workflowId) return { resume: false, reason: 'no checkpoint for this workflow' };
  const next = snapshot.next ?? [];
  if (next.length === 0) return { resume: false, reason: 'workflow had already finished' };
  if (next.includes('executor')) {
    if (k8sWriteMode !== 'remote') {
      return { resume: false, reason: 'interrupted inside the executor with in-process k8s-write (no idempotency cache) — not re-applying steps' };
    }
    const age = now - new Date(snapshot.createdAt ?? 0).getTime();
    if (!(age >= 0 && age < EXECUTOR_REPLAY_WINDOW_MS)) {
      return { resume: false, reason: `interrupted inside the executor ${Math.round(age / 60000)} min ago — past the k8s-write replay window` };
    }
  }
  return { resume: true, next };
}

// Continue a workflow a previous process life left mid-run. Returns
// { resumed: false, reason } (and drops its checkpoint) when it shouldn't be resumed.
async function resumeWorkflow({ workflowId }) {
  if (!checkpointer) return { resumed: false, reason: 'checkpointing disabled' };
  const snapshot = await compiled.getState({ configurable: { thread_id: workflowId } });
  const decision = _resumeDecision(snapshot, { k8sWriteMode: k8sWrite.mode });
  if (!decision.resume) {
    await checkpointer.deleteThread(workflowId).catch(() => {});
    return { resumed: false, reason: decision.reason };
  }

  const issues = snapshot.values.issues ?? [];
  console.log(`[GRAPH] resuming workflow ${workflowId} at ${decision.next.join(', ')} (attempt ${snapshot.values.attempt ?? 0}/${MAX_FIX_ATTEMPTS})`);
  const incidentTracer = new IncidentTracer({ workflowId, resource: resourceFromIssue(issues[0] ?? {}) });
  const result = await _invokeWorkflow(null, { workflowId, issues, incidentTracer });
  return { resumed: true, result };
}

module.exports = {
  runWorkflow,
  resumeWorkflow,
  useCheckpointer,
  graph: compiledBase,
  // Exported for unit testing the resume safety rules in isolation.
  _resumeDecision, EXECUTOR_REPLAY_WINDOW_MS,
  // Exported for unit testing the verdict/attempt → branch mapping in isolation
  // (see graph.test.js) without mocking the full agent/store dependency graph.
  routeAfterPlanner, routeAfterPolicy, shouldEscalate, requiresApproval, MAX_FIX_ATTEMPTS,
  // Exported for unit testing the Phase 2 Fast Path routing decisions in isolation.
  routeByComplexity, routeAfterFastPath,
  // Exported so a plain-Node harness (see scripts/test-fastpath-live.js) can drive
  // fastPathNode directly with a monkey-patched fastPath.diagnose(), the same
  // require()-cache-sharing pattern used for investigator.js/graph.js elsewhere —
  // this repo's Vitest can't reliably mock nested require() between CJS files.
  fastPathNode,
  // Exported so a plain-Node harness (see scripts/verify-rootcausefit-advisory.js) can
  // drive guardianNode directly and prove the Phase 4 advisory check never affects the
  // returned verdict, same monkey-patch pattern as fastPathNode above.
  guardianNode,
  // Exported so a harness (scripts/test-orchestrator-visualize.js) can show the exact
  // incident -> issue shape investigatorNode hands to investigator.investigate(),
  // without re-deriving the mapping by hand.
  _toIssue,
  // Exported for unit testing the fleet-wide clusterConfigs lookup in isolation.
  _clusterFor,
  // Exported for unit testing the multi-cluster-safe fallback in isolation.
  _issueForStep,
  // Exported for unit testing §Fix-RootCauseGate / §Fix-ExecutorHonesty in isolation,
  // without needing a live LLM call through guardianNode.
  _actionCannotAddressRootCause,
  // Exported for unit testing §Fix-RetryLoop's routing decision and the shared
  // resolved/escalate rule in isolation, without mocking the full executor/reflexion
  // dependency graph (kubectl, escalationStore, issueTrackerStore, shortMemory, etc.).
  routeAfterExecutor, _issueResolution,
};
