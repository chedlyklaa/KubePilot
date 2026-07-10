'use strict';
require('dotenv').config({ override: true });
const OpenAI      = require('openai');
const tokenStore     = require('../api/tokenStore');
const { runLLMCall } = require('../resilience/llmCircuitBreaker');
const fallbackPlanner = require('../resilience/fallbackPlanner');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const MODEL = process.env.OPENAI_MODEL;

const VALID_ACTIONS = new Set([
  'restart', 'rollback', 'delete_pod', 'scale_down', 'increase_memory', 'noop',
  'cordon_node', 'drain_node', 'uncordon_node',
]);

const SYSTEM = `You are a Kubernetes SRE Planner Agent.
You receive a detected incident (pod or node level), recent pod logs, real-time Prometheus metrics, Kubernetes events, correlation findings, past similar incidents from operational memory, and learned rules.
Your job is to select the safest, most effective remediation action — informed by all available evidence.

Before proposing any action, reason explicitly about the failure origin:
  1. POD CAUSE   — is this isolated to one pod/container?
  2. NODE CAUSE  — are multiple pods on the same node failing? Does the node have conditions?
  3. CLUSTER CAUSE — is this a scheduling or capacity failure affecting many pods?

Node-level actions (cordon_node, drain_node, uncordon_node) should only be proposed when:
  - Multiple pods on one node are failing AND the node has active conditions, OR
  - NodeAnalyzer explicitly reports a NodeNotReady / NodeMemoryPressure / NodeDiskPressure condition.

Output ONLY valid JSON. No markdown.`;

class PlannerAgent {
  constructor() {
    // ── Context section registry ──────────────────────────────────────────
    // Each entry formats one optional evidence block for plan()'s prompt. Adding a new
    // signal source (a new engine's output) means adding ONE entry here — not a new
    // destructured param, a new method, AND a new template insertion point kept in sync
    // by hand across three places.
    //
    // `prefix` reproduces this file's historical prompt layout exactly: the first seven
    // sections were each on their own template-literal line, so got an unconditional
    // leading blank line even when empty; the last three were concatenated with no
    // separator, relying solely on each formatter's own leading '\n' when non-empty.
    // New sections should normally use prefix: '' (self-contained leading '\n' inside
    // the formatter itself, as changeCorrelation/capacityForecast/rca already do) so an
    // inactive section doesn't leave a stray blank line.
    this.contextSections = [
      { key: 'metrics',           prefix: '\n', formatter: p => this._formatMetrics(p.metrics) },
      { key: 'nodeContext',       prefix: '\n', formatter: p => this._formatNodeContext(p.nodeMetrics, p.nodeIssues) },
      { key: 'events',            prefix: '\n', formatter: p => this._formatEvents(p.events, p.issue) },
      { key: 'correlation',       prefix: '\n', formatter: p => this._formatCorrelation(p.correlationFindings, p.clusterFindings) },
      { key: 'pastEpisodes',      prefix: '\n', formatter: p => this._formatPastEpisodes(p.structuralMatches, p.semanticMatches) },
      { key: 'learnedRules',      prefix: '\n', formatter: p => this._formatRules(p.learnedRules) },
      { key: 'investigationGate', prefix: '\n', formatter: p => this._formatInvestigationContext(p.investigationContext) },
      { key: 'changeCorrelation', prefix: '',   formatter: p => this._formatChangeCorrelation(p.changeCorrelation) },
      { key: 'capacityForecast',  prefix: '',   formatter: p => this._formatCapacityForecast(p.capacityForecast) },
      {
        key: 'rootCauseAnalysis', prefix: '',
        formatter: p => (p.rca && p.rca.confidence > 0)
          ? `\nRoot cause analysis:\nSuspected cause: ${p.rca.suspected_cause}\nConfidence: ${p.rca.confidence}\nEvidence: ${(p.rca.evidence ?? []).join(', ')}\nRisk level: ${p.rca.risk_level}\nFocus: ${p.rca.recommended_focus}\nUse this analysis to inform your action decision.`
          : '',
      },
    ];
  }

  // Builds the full dynamic-evidence block from the registered context sections above.
  _buildContextBlock(params) {
    return this.contextSections.map(s => s.prefix + s.formatter(params)).join('');
  }

  /**
   * Plan remediation for a pod issue.
   * All existing parameters preserved; new optional node/event/correlation context added.
   */
  async plan(params) {
    const {
      issue, podLogs, attempt, structuralMatches, semanticMatches, learnedRules, metrics,
      // Defaults applied here since params is no longer destructured in the signature —
      // callers may omit any of these exactly as before.
      nodeMetrics = null, nodeIssues = [], events = [], correlationFindings = [], clusterFindings = [],
      investigationContext = null, rca = null, changeCorrelation = null, capacityForecast = null,
    } = params;
    const normalizedParams = {
      ...params,
      nodeMetrics, nodeIssues, events, correlationFindings, clusterFindings,
      investigationContext, rca, changeCorrelation, capacityForecast,
    };

    const hasDeployment = !!issue.deployment;
    const contextBlock = this._buildContextBlock(normalizedParams);

    const prompt = `CURRENT ISSUE
issueType:    ${issue.type}
pod:          ${issue.podName ?? 'N/A'}
deployment:   ${issue.deployment ?? 'none — bare pod'}
ownerKind:    ${issue.ownerKind ?? 'none (bare pod)'}
controller:   ${issue.controllerName ?? 'none'}
namespace:    ${issue.namespace ?? 'default'}
nodeName:     ${issue.nodeName ?? 'unknown'}
oomKilled:    ${issue.oomKilled ?? false}
exitCode:     ${issue.exitCode ?? 'N/A'}
restartCount: ${issue.restartCount ?? 0}
attempt:      #${attempt}
${podLogs ? `\nRECENT POD LOGS\n${podLogs.slice(-1200)}` : ''}${contextBlock}
ACTION DECISION TREE — follow this top-to-bottom, pick the FIRST match:

Step 1: Is oomKilled=true OR exitCode=137?
  YES → increase_memory (this is the ONLY situation where increase_memory is correct)
  NO  → continue to step 2

Step 2: What is the ownerKind?
  Job → noop (Jobs run to completion, do not interfere)
  none (bare pod) → noop (no controller to recreate it; escalate for human decision)
  Deployment, StatefulSet, DaemonSet → continue to step 3

Step 3: Is the issue ImagePullBackOff or ErrImagePull?
  YES → noop (kubectl cannot fix a missing image or bad credentials)
  NO  → continue to step 4

Step 4: Was there a recent deployment change? (check rollout history, investigationContext)
  YES → rollback (revert to the last working revision)
  NO  → continue to step 5

Step 5: Is the crash transient (exit code 1/2, application error, connection refused)?
  YES → restart (rollout restart recycles pods with same config)
  NO  → continue to step 6

Step 6: Is the exit code 126 or 127? (permission denied / binary not found)
  YES and Deployment/StatefulSet → rollback (bad image or entrypoint)
  YES and DaemonSet → restart (DaemonSets don't support rollout undo)
  NO  → noop (unclear cause, escalate)

IMPORTANT: increase_memory is ONLY for OOM kills (step 1). If oomKilled is false and exitCode is not 137, do NOT choose increase_memory — choose restart, rollback, or noop instead.

Node actions (only when the node itself is the root cause):
- cordon_node   : node has conditions (NotReady/Pressure) OR multiple pods failing on same node.
- drain_node    : node critically degraded, needs to be emptied. High blast radius.
- uncordon_node : node recovered, re-enable scheduling.
- noop          : no safe automated fix available.

deployment present: ${hasDeployment}
ownerKind: ${issue.ownerKind ?? 'none'}
has controller: ${!!issue.controllerName}
oomKilled: ${issue.oomKilled ?? false}

REFERENCE DECISIONS (learn the pattern, not the specifics):
1. oomKilled=true, exitCode=137, ownerKind=Deployment
   → {"action":"increase_memory","rootCause":"Container killed by OOM killer — memory limit too low"}
   WHY: OOM is the ONLY reason to increase memory. Restart would crash again immediately.

2. oomKilled=false, exitCode=1, ownerKind=Deployment, logs show "connection refused"
   → {"action":"restart","rootCause":"Application crashed due to transient dependency failure"}
   WHY: No OOM signal, so NOT increase_memory. Generic crash with a transient cause → restart.

3. oomKilled=false, exitCode=1, ownerKind=Deployment, rollout history shows recent revision change
   → {"action":"rollback","rootCause":"Application crash after recent deployment — likely bad config or image"}
   WHY: Recent change + crash = correlation. Rollback to last known-good state.

4. oomKilled=false, exitCode=1, ownerKind=none (bare pod)
   → {"action":"noop","rootCause":"Bare pod crashed — no controller to restart it safely"}
   WHY: No controller means restart/rollback/scale are impossible. Escalate for human.

5. type=ImagePullBackOff, ownerKind=Deployment
   → {"action":"noop","rootCause":"Image does not exist or registry credentials are missing"}
   WHY: No kubectl action can fix a bad image reference. Human must update the manifest.

Return ONLY valid JSON:
{
  "rootCause":     "one-sentence diagnosis",
  "failureOrigin": "pod|node|cluster",
  "action":        "increase_memory|restart|rollback|delete_pod|scale_down|cordon_node|drain_node|uncordon_node|noop",
  "targetNode":    "node name if action is a node action, else null",
  "risk":          "LOW|MEDIUM|HIGH",
  "confidence":    0.0,
  "rationale":     "why this action"
}`;

    const t0 = Date.now();
    console.log(
      `[PLANNER] issue=${issue.type}  attempt=${attempt}` +
      `  pastCtx=${(structuralMatches?.length ?? 0) + (semanticMatches?.length ?? 0)}` +
      `  rules=${learnedRules?.length ?? 0}  metrics=${metrics ? 'yes' : 'unavailable'}` +
      `  nodeCtx=${nodeIssues.length > 0}  events=${events.length}` +
      `  mode=${investigationContext?.mode ?? 'standard'}`
    );

    let raw = '', usage = null;
    const createParams = {
      model: MODEL, temperature: 0.1, stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    };
    try { createParams.response_format = { type: 'json_object' }; } catch {}

    try {
      ({ raw, usage } = await runLLMCall(
        () => client.chat.completions.create(createParams),
        { requiredFields: ['action', 'rootCause'] }
      ));
    } catch (err) {
      if (err.name === 'CircuitOpenError') return fallbackPlanner.plan(issue, err.reason);
      throw err;
    }

    const elapsed = Date.now() - t0;
    tokenStore.record('planner', usage);
    console.log(`[PLANNER] ${elapsed}ms${usage ? `  tokens=${usage.total_tokens}` : ''}`);
    console.log(`[PLANNER] raw: ${raw}`);

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON object found in response');
      parsed = JSON.parse(match[0]);
    } catch (err) {
      console.warn(`[PLANNER] Unparseable response — using noop fallback: ${err.message}`);
      return { rootCause: 'Planner could not parse LLM response', action: 'noop', risk: 'LOW', rationale: 'fallback' };
    }

    if (!VALID_ACTIONS.has(parsed.action)) {
      console.warn(`[PLANNER] Invalid action "${parsed.action}" — defaulting to noop`);
      parsed.action = 'noop';
    }

    // Structural guard: delete_pod makes no sense for deployment-managed pods
    if (parsed.action === 'delete_pod' && hasDeployment) {
      console.warn('[PLANNER] delete_pod overridden to rollback (deployment exists)');
      parsed.action = 'rollback';
    }

    return parsed;
  }

  /**
   * Plan remediation for a node-level issue (NodeNotReady, NodeMemoryPressure, etc.)
   * Separate entry point to keep node prompts focused.
   */
  async planNodeAction({ nodeIssue, nodeMetrics, affectedPods, events, attempt, pastEpisodes = [], learnedRules = [] }) {
    const pastCtx  = this._formatPastEpisodes(pastEpisodes, []);
    const rulesCtx = this._formatRules(learnedRules);

    const prompt = `NODE ISSUE
issueType:     ${nodeIssue.type}
nodeName:      ${nodeIssue.nodeName}
isControlPlane:${nodeIssue.isControlPlane ?? false}
reason:        ${nodeIssue.reason ?? 'Unknown'}
message:       ${nodeIssue.message ?? 'N/A'}
attempt:       #${attempt}

AFFECTED WORKLOADS
pods on this node: ${affectedPods.length}
namespaces: ${[...new Set(affectedPods.map(p => p.namespace))].join(', ') || 'N/A'}
${nodeMetrics ? this._formatNodeMetrics(nodeMetrics) : ''}
${this._formatEvents(events, { nodeName: nodeIssue.nodeName })}
${pastCtx}
${rulesCtx}
NODE ACTION RULES
- cordon_node   : node has conditions but pods can still run elsewhere. Safe first step.
- drain_node    : node needs to be emptied (maintenance, critical degradation). High blast radius.
- uncordon_node : node has recovered; re-enable scheduling.
- noop          : transient condition — monitor and wait.

NEVER propose drain_node for control-plane nodes.
NEVER propose drain_node without estimating blast radius (affectedPods count above).

Return ONLY valid JSON:
{
  "rootCause":  "one-sentence diagnosis of why the node is degraded",
  "action":     "cordon_node|drain_node|uncordon_node|noop",
  "targetNode": "${nodeIssue.nodeName}",
  "risk":       "LOW|MEDIUM|HIGH",
  "confidence": 0.0,
  "rationale":  "why this action"
}`;

    const t0 = Date.now();
    console.log(`[PLANNER] node=${nodeIssue.nodeName}  type=${nodeIssue.type}  attempt=${attempt}  affectedPods=${affectedPods.length}`);

    let raw = '', usage = null;
    const nodeParams = {
      model: MODEL, temperature: 0.1, stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
    };
    try { nodeParams.response_format = { type: 'json_object' }; } catch {}
    try {
      ({ raw, usage } = await runLLMCall(
        () => client.chat.completions.create(nodeParams),
        { requiredFields: ['action', 'rootCause'] }
      ));
    } catch (err) {
      if (err.name === 'CircuitOpenError') return fallbackPlanner.planNodeAction(nodeIssue, err.reason);
      throw err;
    }
    tokenStore.record('planner', usage);
    console.log(`[PLANNER] node ${Date.now() - t0}ms  raw: ${raw}`);

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON');
      const p = JSON.parse(match[0]);
      if (!VALID_ACTIONS.has(p.action)) p.action = 'noop';
      return p;
    } catch {
      return { rootCause: 'parse error', action: 'noop', targetNode: nodeIssue.nodeName, risk: 'LOW', rationale: 'fallback' };
    }
  }

  // ── Change Correlation context ────────────────────────────────────────────
  _formatChangeCorrelation(cc) {
    if (!cc || cc.confidence < 0.2) return '';
    const level = cc.confidence >= 0.60 ? 'HIGH' : cc.confidence >= 0.35 ? 'MEDIUM' : 'LOW';
    const hint  = cc.triggerType === 'Deployment' && cc.confidence >= 0.50
      ? '\n  → Deployment change is a likely trigger. "rollback" is the preferred safe action if logs confirm a regression.'
      : cc.triggerType !== 'Deployment'
        ? `\n  → ${cc.triggerType} change detected. Verify whether the updated config is compatible with the running pods.`
        : '';

    const lines = [
      '\n━━━ CHANGE CORRELATION ━━━',
      `Trigger type:    ${cc.triggerType}`,
      `Trigger:         ${cc.triggerResource}`,
      `Changed at:      ${cc.triggerTimestamp}`,
      `Confidence:      ${cc.confidence.toFixed(2)} (${level})`,
      'Evidence:',
      ...cc.evidence.map(e => `  • ${e}`),
      hint,
    ];
    return lines.join('\n');
  }

  // ── Capacity Forecast context ─────────────────────────────────────────────
  _formatCapacityForecast(fc) {
    if (!fc || (fc.alertLevel !== 'HIGH' && fc.alertLevel !== 'CRITICAL')) return '';

    const eta = fc.hoursToExhaustion != null
      ? ` — predicted exhaustion in ${fc.hoursToExhaustion.toFixed(0)}h (${fc.exhaustionAt?.slice(0, 16).replace('T', ' ')} UTC)`
      : '';
    const hint = fc.resource === 'memory'
      ? '\n  → Memory trending toward OOM independently of deployment changes.\n    Prefer "increase_memory" or "scale_down" over "rollback" unless change correlation also points to a recent deployment.'
      : fc.resource === 'cpu'
        ? '\n  → CPU saturation is trending. Consider "scale_down" to reduce load or investigate throttling root cause.'
        : '\n  → Resource is trending toward saturation. Take capacity action before incident escalates.';

    const lines = [
      '\n━━━ CAPACITY FORECAST ━━━',
      `Resource:    ${fc.resource} on ${fc.target}`,
      `Current:     ${fc.currentPct}% (growing +${fc.slope}%/h)`,
      `Alert level: ${fc.alertLevel}${eta}`,
      `Confidence:  ${fc.confidence} (${fc.dataPointCount} data points over ${fc.lookbackHours}h)`,
      hint,
    ];
    return lines.join('\n');
  }

  // ── Investigation Gate context ────────────────────────────────────────────
  _formatInvestigationContext(ctx) {
    if (!ctx) return '';

    const lines = [
      '\n━━━ INVESTIGATION CONTEXT ━━━',
      `decision_mode: ${ctx.mode}`,
      `reasons:       ${ctx.reasons.join(', ')}`,
      `confidence:    ${ctx.confidence}`,
      '',
      'Evidence was automatically enriched because initial data was ambiguous.',
      'Weight the additional evidence below carefully before forming a diagnosis.',
      'Prefer a specific targeted action (rollback, restart, increase_memory) over noop.',
      'Only choose noop if you are certain no automated action is safe after reviewing all evidence.',
    ];

    if (ctx.previousLogs) {
      lines.push('\nPREVIOUS CONTAINER LOGS (output from the container run before the current restart)');
      lines.push(ctx.previousLogs.slice(-1500));
    }

    if (ctx.describeEvents) {
      lines.push('\nKUBECTL DESCRIBE — EVENTS SECTION');
      lines.push(ctx.describeEvents.slice(0, 1200));
    }

    if (ctx.rolloutHistory) {
      lines.push('\nROLLOUT HISTORY (use to determine if rollback is a safe option)');
      lines.push(ctx.rolloutHistory.slice(0, 400));
    }

    return lines.join('\n');
  }

  // ── Format pod Prometheus metrics ─────────────────────────────────────────
  _formatMetrics(metrics) {
    if (!metrics) return '';
    const lines = ['\nPOD METRICS SNAPSHOT (Prometheus — last 15 minutes)'];
    if (metrics.cpu)     lines.push(`CPU       avg=${metrics.cpu.avgPct}%  peak=${metrics.cpu.peakPct}%  trend=${metrics.cpu.trend}`);
    if (metrics.memory)  lines.push(`Memory    avg=${metrics.memory.avgMi}Mi  peak=${metrics.memory.peakMi}Mi  trend=${metrics.memory.trend}`);
    if (metrics.restarts?.count != null) lines.push(`Restarts  ${metrics.restarts.count}`);
    if (metrics.oomDetected != null)     lines.push(`OOMKilled ${metrics.oomDetected}`);
    return lines.join('\n');
  }

  // ── Format node-level metrics ─────────────────────────────────────────────
  _formatNodeContext(nodeMetrics, nodeIssues) {
    const lines = [];
    if (nodeIssues?.length) {
      lines.push('\nNODE CONDITIONS ON THIS POD\'s NODE');
      for (const n of nodeIssues) {
        lines.push(`  • ${n.type}  node=${n.nodeName}  reason=${n.reason ?? '—'}`);
      }
    }
    if (nodeMetrics) {
      lines.push('\nNODE METRICS (Prometheus)');
      if (nodeMetrics.cpuUsagePct != null)  lines.push(`  CPU     ${nodeMetrics.cpuUsagePct}%`);
      if (nodeMetrics.memUsedPct  != null)  lines.push(`  Memory  ${nodeMetrics.memUsedPct}%`);
      if (nodeMetrics.diskUsedPct != null)  lines.push(`  Disk    ${nodeMetrics.diskUsedPct}%`);
    }
    return lines.join('\n');
  }

  _formatNodeMetrics(m) {
    if (!m) return '';
    const lines = ['\nNODE METRICS'];
    if (m.cpuUsagePct  != null) lines.push(`  CPU     ${m.cpuUsagePct}%`);
    if (m.memUsedPct   != null) lines.push(`  Memory  ${m.memUsedPct}% (${Math.round((m.memUsedBytes ?? 0) / 1024 / 1024 / 1024 * 10) / 10} GiB used)`);
    if (m.diskUsedPct  != null) lines.push(`  Disk    ${m.diskUsedPct}%`);
    if (m.netRxBytesPerSec != null) lines.push(`  Net Rx  ${Math.round(m.netRxBytesPerSec / 1024)} KiB/s`);
    return lines.join('\n');
  }

  // ── Format Kubernetes events ──────────────────────────────────────────────
  _formatEvents(events, issue) {
    if (!events?.length) return '';
    // Filter to events relevant to this pod/node
    const relevant = events.filter(e =>
      (issue?.podName    && e.name      === issue.podName)    ||
      (issue?.nodeName   && e.nodeName  === issue.nodeName)   ||
      (issue?.namespace  && e.namespace === issue.namespace)
    ).slice(0, 8);
    if (!relevant.length) return '';
    const lines = ['\nRELEVANT KUBERNETES EVENTS'];
    for (const e of relevant) {
      lines.push(`  [${e.count}×] ${e.reason} — ${e.namespace}/${e.name}` +
        (e.message ? ` | ${e.message.slice(0, 100)}` : ''));
    }
    return lines.join('\n');
  }

  // ── Format correlation findings ───────────────────────────────────────────
  _formatCorrelation(correlationFindings, clusterFindings) {
    if (!correlationFindings?.length && !clusterFindings?.length) return '';
    const lines = ['\nCORRELATION & CLUSTER CONTEXT'];
    for (const f of correlationFindings ?? []) {
      lines.push(`  [${f.level?.toUpperCase() ?? 'NODE'}] ${f.message}  (confidence:${f.confidence})`);
    }
    for (const f of clusterFindings ?? []) {
      lines.push(`  [CLUSTER] ${f.type}: ${f.message}`);
    }
    return lines.join('\n');
  }

  // ── Format past episodes ──────────────────────────────────────────────────
  _formatPastEpisodes(structural, semantic) {
    if (!structural?.length && !semantic?.length) return '';
    const lines = ['\nPAST SIMILAR INCIDENTS (use to inform your decision)'];
    if (structural?.length) {
      lines.push('Structurally identical:');
      for (const ep of structural) {
        const actions = (ep.timeline || []).map(t => `${t.action}→${t.outcome}`).join(', ');
        lines.push(`  • ${ep.fingerprint?.issueType}  actions:[${actions}]  resolved:${ep.resolved}  final:${ep.resolvedAction ?? 'escalated'}`);
        if (ep.reflection?.lessonsLearned) lines.push(`    lesson: ${ep.reflection.lessonsLearned}`);
      }
    }
    if (semantic?.length) {
      lines.push('Semantically similar:');
      for (const hit of semantic) {
        lines.push(`  • ${hit.payload?.issueType}  resolved:${hit.payload?.resolved}  final:${hit.payload?.resolvedAction ?? 'escalated'}  (sim:${hit.score?.toFixed(2)})`);
      }
    }
    return lines.join('\n');
  }

  // ── Format learned rules ──────────────────────────────────────────────────
  _formatRules(rules) {
    if (!rules?.length) return '';
    const lines = ['\nLEARNED RULES (apply these)'];
    for (const r of rules) {
      lines.push(`  • [${r.issueType}] ${r.rule}  (confidence:${r.confidence?.toFixed(2)}, occurrences:${r.occurrences})`);
    }
    return lines.join('\n');
  }
}

module.exports = new PlannerAgent();
