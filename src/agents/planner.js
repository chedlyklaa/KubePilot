'use strict';
require('dotenv').config({ override: true });
const { ChatOpenAI }  = require('@langchain/openai');
const { tool }        = require('@langchain/core/tools');
const { z }           = require('zod');
const { SystemMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const investigator    = require('./investigator');
// Cluster reads/writes go through the k8s gateways (src/tools/k8sGateway.js) so this
// agent can run as its own service with no cluster credentials of its own.
const { k8sRead, k8sWrite } = require('../tools/k8sGateway');
const ChangeCorrelationEngine = require('./changeCorrelationEngine');
const CapacityForecastEngine  = require('./capacityForecastEngine');
const { loadConfig }  = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { PlanSchema, PlanStepSchema } = require('../orchestrator/schemas');
const { issueKey: _issueKey } = require('../orchestrator/issueKey');

// ── Planner ──────────────────────────────────────────────────────────────────
// Standalone, like investigator.js — its external dependencies are executor.js
// (dry-run), investigator.js (read-only evidence gathering, already exported for
// exactly this kind of reuse), ChangeCorrelationEngine/CapacityForecastEngine
// (deterministic per-issue context — recent-deployment correlation, capacity trend —
// both already degrade to null on their own when disabled/unavailable), config, and
// the shared schemas — all plain function calls today, so this can become its own
// process later too.
//
// The legacy src/agents/plannerAgent.js is untouched — it still serves ClusterAgent's
// pipeline (no longer reachable from the main entrypoint), and produces one action per
// call (single-step). This file replaces it in the v5 graph with real multi-step planning
// (architecture-doc §3.3): "a sequence of commands, not a single command."

const _config = loadConfig();
const PLANNER_API_KEY  = _config.PLANNER_API_KEY  || _config.OPENAI_API_KEY;
const PLANNER_BASE_URL = _config.PLANNER_BASE_URL || _config.OPENAI_BASE_URL;
const PLANNER_MODEL    = _config.PLANNER_MODEL    || _config.OPENAI_MODEL;

const baseLlm = new ChatOpenAI({
  apiKey: PLANNER_API_KEY,
  model:  PLANNER_MODEL,
  configuration: PLANNER_BASE_URL ? { baseURL: PLANNER_BASE_URL } : undefined,
  temperature: 0.1,
});

const usingDedicated = !!(_config.PLANNER_API_KEY && _config.PLANNER_MODEL);
console.log(`[PLANNER] LLM: ${usingDedicated ? `dedicated (${PLANNER_MODEL})` : `shared fallback (${PLANNER_MODEL})`}`);

const MAX_TOOL_ITERATIONS = 15; // bounded, smaller than Investigator's 40 — planning a
                                 // known set of resources needs fewer rounds than
                                 // open-ended evidence gathering.
const SUBMIT_TOOL_NAME = 'submit_plan';

const SYSTEM_PROMPT = `You are a Kubernetes remediation Planner.
You've been given one or more incidents and the Investigator's root-cause report for
them. Incidents may span more than one cluster — each carries its own "clusterName".
Produce a PLAN: an ORDERED SEQUENCE of one or more steps — not a single command —
reflecting how real remediations actually work (e.g. cordon a node, drain it, patch the
deployment, then uncordon; or several independent steps addressing several related
incidents in the same namespace). A single step always targets exactly ONE cluster — if
the same fix is needed in more than one cluster (e.g. rolling back the same deployment
everywhere it broke), emit one step per cluster, never one step that vaguely covers
several at once; the Executor needs an unambiguous single-cluster target per step.

You are NOT restricted to a fixed list of actions. Write the COMPLETE kubectl command
yourself — any verb, any resource, whatever the fix actually requires (rollout restart,
rollout undo, scale, patch, set resources, apply, delete, label, annotate, cordon, drain,
uncordon, and anything else a real operator would reach for). This is real authority, so:
  - Be exact. A vague or overly broad command (missing --namespace, a bare "delete" with
    no specific resource name, an unbounded label selector) is exactly the kind of mistake
    Guardian is there to catch — don't rely on it to fix a sloppy command, write a precise
    one.
  - Target only what the target field names. One step, one resource (or, for a node
    action, one node) — never a command that could touch more than what "target" declares.
  - Never write a destructive command you can't justify from the investigation's actual
    evidence. If you're proposing something drastic (deleting a resource, scaling to zero,
    draining a node), the "reason" field must make it obvious why nothing gentler works.

Each step needs:
  action:         a short label for what this step does (e.g. "restart the deployment",
                   "increase memory limit", "patch the ConfigMap") — for logging/display,
                   not matched against anything
  command:        the COMPLETE kubectl command for this step — the verb and every
                   argument it needs. Do NOT include "kubectl" or "--context", both are
                   added automatically. Example: "rollout restart deployment/api -n prod"
                   or "set resources deployment/api -n prod --limits=memory=512Mi".
                   Leave this EMPTY ("") if there is genuinely no safe automated fix for
                   this step — that is the only way to signal "do nothing here".
  target:         { kind, name, namespace }
  reason:         why this step, specifically
  risk:           low | medium | high | critical
  reversible:     true only if you can name a real inverse COMMAND; be honest — a false
                  "reversible" is worse than an honest "not reversible" (which correctly
                  raises the step's risk tier downstream and forces human approval)
  inverseCommand: the literal command that undoes this step (e.g. "uncordon node-1" for
                  a "cordon node-1" step), or null if genuinely not reversible
  issueKeys:      which incident(s) (their "namespace/resource" key) this step addresses

You have two tools before you finalize:
- dry_run_step: validates ONE proposed step against the REAL cluster
  (kubectl --dry-run=server) without applying it — pass "clusterName" saying which
  cluster to validate against. Use it before submitting, especially for anything you're
  not fully sure will succeed — it directly answers "would the cluster reject this?"
- gather_more_evidence: if the Investigator's report leaves you uncertain what to plan,
  request more read-only evidence yourself (same execution layer the Investigator has —
  get/describe/logs/top/explain/api-resources/api-versions/version/cluster-info only;
  write commands are always rejected) — pass "clusterName" saying which cluster to
  inspect.

━━━ ISSUE-SPECIFIC GUIDANCE (there is no deterministic layer enforcing these anymore —
Guardian and you are the safety net, so apply this yourself) ━━━
  OOMKilled / CrashLoopBackOff with oomKilled=true → the fix must raise the container's
    memory limit/request; a restart alone will just recur.
  CrashLoopBackOff (oomKilled=false) → restart or rollback the deployment; do not delete
    the pod directly if it's controller-managed (the controller just recreates it).
  ImagePullBackOff / ErrImagePull → kubectl cannot fix a bad image URL or missing pull
    credentials. Do not invent a command for this — leave "command" EMPTY (""), set
    action to something like "no automated fix available", and explain why in "reason";
    an empty command is how you signal "nothing safe to run" and lets it fall to
    escalation instead of running a command that can't actually fix it.
  Bare pod (no owning controller) → deleting it is real and permanent; only do it if the
    investigation clearly supports it.
  Deployment/StatefulSet/DaemonSet-managed pod → never target the pod directly with a
    destructive command; target the controller (rollout restart/undo, patch, scale).
  Job-managed pod → Jobs run to completion; don't restart, delete, or patch them.

Each incident in the input may include "changeCorrelation" (whether a recent deployment/
config change correlates with the failure) and "capacityForecast" (memory/CPU/disk trend
toward exhaustion), when available. If changeCorrelation indicates a recent change is the
likely cause, strongly prefer a rollback-style fix (e.g. "rollout undo") over other
actions for that incident. If capacityForecast shows a HIGH or CRITICAL alert level,
weight that trend into whether a capacity-related step (e.g. raising memory limits) is
warranted now versus waiting.

Each incident may also include "nodeCapacity" — the real, current allocatable resources
of every schedulable node in that incident's cluster, and how many nodes there are.
Whenever a step's correct VALUE depends on capacity (how many replicas will actually
schedule, whether a resource request/limit is realistic for the nodes that exist, whether
a node has room for pods drained off another one), work the actual number out from this
data, or call gather_more_evidence for whatever else you need (current resource requests,
current replica count, node conditions) — never guess, and never simply repeat a number
already present in the issue's current (broken) state on the assumption that it's safe.
dry_run_step's "kubectl --dry-run=server" only checks whether the API server would admit
the object; it does NOT simulate scheduling, so it will not catch a replica count or
resource request the cluster actually has no room for — for a scale/resize step, treat
dry_run_step's result together with any capacity advisory it returns, not the dry-run
result alone. If the evidence available still isn't enough to compute a defensible
number, leave command EMPTY rather than propose an arbitrary one.

If the input includes "previousAttempt", an earlier automated attempt at fixing this
EXACT issue already ran and did not resolve it (it names the command that was tried and
why it didn't verify fixed, or why it was rejected before it could run). Do not resubmit
that same command unchanged — either propose something meaningfully different that
addresses why it failed, or, if you genuinely believe no automated fix exists, leave
command EMPTY rather than repeating a guess that already didn't work.

When ready, call ${SUBMIT_TOOL_NAME} with your full ordered step list.`;

// `clusterConfigs` is the fleet map { [clusterName]: { context, tier, ... } }. Same
// safety property as investigator.js's read-only tool: the model picks a clusterName
// from a z.enum of REAL, known clusters, never a raw context/kubeconfig value — context
// resolution happens entirely server-side. The dry-run tool's exposed "clusterName" is
// a SEPARATE, REQUIRED parameter from PlanStepSchema's own (optional, code-derived-only)
// clusterName field — this one is mid-loop, model-supplied, and used only to pick which
// cluster's API server validates the dry-run; the final plan step's clusterName is
// attached later by graph.js's plannerNode from the resolved issue, never trusted from
// here (see the comment on PlanStepSchema.clusterName in schemas.js for why).
// §Fix-CapacityEvidence (2026-09-16) — `kubectl --dry-run=server` (what dry_run_step
// actually runs) only asks the API server whether it would ADMIT the object; admission
// never invokes the scheduler, so it happily "passes" a replica count or resource
// request the cluster has no room for. Confirmed live (2026-09-14, mk-overscaled):
// the Planner scaled to --replicas=24 — the deployment's own already-broken current
// value — three runs in a row, never the right-sized --replicas=2, because nothing it
// had access to could tell it whether either number would actually schedule. This is a
// real, deterministic capacity CALCULATION appended to the dry-run result as advisory
// information — it never blocks or rewrites the step itself, it just gives the model
// the arithmetic so its own free-form choice of replica count can be evidence-based
// instead of a guess. Best-effort only: any fetch/parse failure just omits the advisory,
// the underlying dry-run result is still returned.
async function _capacityAdvisoryForScale(step, cfg) {
  const replicasMatch = /--replicas[= ](\d+)/.exec(step.command ?? '');
  if (!replicasMatch || step.target?.kind === 'Node') return null;
  const targetReplicas = parseInt(replicasMatch[1], 10);

  const [nodesJson, deployments] = await Promise.all([
    k8sRead.getNodes({ context: cfg.context }),
    k8sRead.getDeploymentsFull({ namespace: step.target.namespace ?? 'default', context: cfg.context }),
  ]);
  const deployment = deployments.find(d => d.metadata?.name === step.target.name);
  const containers = deployment?.spec?.template?.spec?.containers ?? [];
  if (containers.length === 0) return null; // target not found or has no containers to size from

  const perReplicaCpuM  = containers.reduce((sum, c) => sum + _cpuToMillicores(c.resources?.requests?.cpu), 0);
  const perReplicaMemMi = containers.reduce((sum, c) => sum + _memToMi(c.resources?.requests?.memory), 0);
  if (perReplicaCpuM === 0 && perReplicaMemMi === 0) return null; // no requests set — nothing to compute against

  const schedulable = (nodesJson.items ?? []).filter(n => n.spec?.unschedulable !== true);
  const totalCpuM  = schedulable.reduce((sum, n) => sum + _cpuToMillicores(n.status?.allocatable?.cpu), 0);
  const totalMemMi = schedulable.reduce((sum, n) => sum + _memToMi(n.status?.allocatable?.memory), 0);
  const neededCpuM  = perReplicaCpuM * targetReplicas;
  const neededMemMi = perReplicaMemMi * targetReplicas;
  const fits = neededCpuM <= totalCpuM && neededMemMi <= totalMemMi;

  return `${targetReplicas} replica(s) x (cpu=${perReplicaCpuM}m, memory=${Math.round(perReplicaMemMi)}Mi) each ` +
    `= ${neededCpuM}m cpu / ${Math.round(neededMemMi)}Mi memory requested in total, vs ` +
    `${totalCpuM}m cpu / ${Math.round(totalMemMi)}Mi memory allocatable across ${schedulable.length} schedulable node(s). ` +
    (fits
      ? 'Fits within allocatable capacity (other pods already on those nodes may still reduce actual headroom).'
      : 'EXCEEDS allocatable capacity as computed — this replica count will not all schedule.');
}

function _buildDryRunTool(clusterConfigs) {
  const clusterNames = Object.keys(clusterConfigs);
  return tool(
    async (args) => {
      let step;
      try { step = PlanStepSchema.parse(args); }
      catch (err) { return `ERROR: step did not match the required shape: ${err.message}`; }
      const cfg = clusterConfigs[args.clusterName];
      if (!cfg) return `ERROR: unknown clusterName "${args.clusterName}" — must be one of: ${clusterNames.join(', ')}`;
      try {
        const result = await k8sWrite.dryRun({ step, context: cfg.context });
        const base = result == null ? '(dry-run passed — no objection from the API server)' : String(result);
        const advisory = await _capacityAdvisoryForScale(step, cfg).catch(() => null);
        return advisory
          ? `${base}\n\nCAPACITY CHECK (informational — kubectl --dry-run=server does not simulate scheduling, only API admission): ${advisory}`
          : base;
      } catch (err) {
        return `REJECTED by cluster: ${err.message}`;
      }
    },
    {
      name: 'dry_run_step',
      description: 'Validate ONE proposed step against the real cluster (kubectl --dry-run=server) without ' +
        'applying it. Pass the same shape a plan step needs (action, command, target {kind,name,namespace}, ' +
        `reason, risk) plus "clusterName" (one of: ${clusterNames.join(', ')}) saying which cluster to validate against.`,
      schema: PlanStepSchema.extend({ clusterName: z.enum(clusterNames.length ? clusterNames : ['unknown']) }),
    }
  );
}

function _buildEvidenceTool(clusterConfigs) {
  const clusterNames = Object.keys(clusterConfigs);
  return tool(
    async ({ clusterName, command }) => {
      const cfg = clusterConfigs[clusterName];
      if (!cfg) return `ERROR: unknown clusterName "${clusterName}" — must be one of: ${clusterNames.join(', ')}`;
      return investigator.executeReadOnlyCommand(command, cfg.context);
    },
    {
      name: 'gather_more_evidence',
      description: 'Run a READ-ONLY kubectl command for more evidence before planning. ' +
        `Set "clusterName" to which cluster to run it against (one of: ${clusterNames.join(', ')}). ` +
        'Provide only the subcommand and arguments — do NOT include "kubectl" or "--context". Only get/describe/logs/top/' +
        'explain/api-resources/api-versions/version/cluster-info are permitted; anything else is rejected.',
      schema: z.object({
        clusterName: z.enum(clusterNames.length ? clusterNames : ['unknown']),
        command: z.string().describe('kubectl subcommand and arguments, without "kubectl" or "--context"'),
      }),
    }
  );
}

// The "finish" tool — its arguments ARE the plan. No real side effect; the loop below
// intercepts the call, validates it against PlanSchema, and either accepts it or
// rejects it back to the model with an explanation, via the normal tool-result channel.
function _buildSubmitTool() {
  return tool(
    async (args) => JSON.stringify(args),
    {
      name: SUBMIT_TOOL_NAME,
      description: 'Submit your final ordered plan — one or more steps.',
      schema: z.object({ steps: z.array(PlanStepSchema).min(1) }),
    }
  );
}

// §Fix-CapacityEvidence (2026-09-16) — Kubernetes resource-quantity parsing, minimal but
// correct for the suffixes kubectl actually emits (binary Ki/Mi/Gi/Ti, decimal K/M/G/T,
// bare millicores "500m", bare cores "2", bare bytes). Returns millicores / mebibytes so
// the two are directly comparable/summable regardless of which suffix the source used.
function _cpuToMillicores(q) {
  if (q == null) return 0;
  const s = String(q).trim();
  if (s.endsWith('m')) return parseInt(s, 10) || 0;
  return Math.round((parseFloat(s) || 0) * 1000);
}
const _MEM_UNIT_TO_MI = {
  Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024,
  K: 1000 / (1024 * 1024), M: (1000 ** 2) / (1024 * 1024), G: (1000 ** 3) / (1024 * 1024), T: (1000 ** 4) / (1024 * 1024),
};
function _memToMi(q) {
  if (q == null) return 0;
  const m = String(q).trim().match(/^(\d+(?:\.\d+)?)([EPTGMK]i?)?$/);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  if (!m[2]) return value / (1024 * 1024); // bare bytes
  return (_MEM_UNIT_TO_MI[m[2]] ?? 0) * value;
}

// Real, current scheduling capacity for one cluster — gathered once per CLUSTER present
// in this planning batch (not per issue: it's the same fact for every issue in that
// cluster), so the model has actual numbers instead of guessing or echoing back a value
// already present in the issue's own (broken) spec. Deliberately NOT gated on issue
// type — same reasoning as changeCorrelation/capacityForecast below: always attach the
// real evidence and let the model's own judgment (see SYSTEM_PROMPT's capacity
// paragraph) decide when it's relevant, rather than hardcoding a list of "capacity-
// relevant" issue types that will inevitably miss some future case. Best-effort: a fetch
// failure degrades to null for that cluster, same as changeCorrelation/capacityForecast.
async function _gatherNodeCapacity(clusterConfigs, clusterNames) {
  const entries = await Promise.all(clusterNames.map(async clusterName => {
    const cfg = clusterConfigs[clusterName];
    if (!cfg?.context) return [clusterName, null];
    try {
      const nodes = await k8sRead.getNodes({ context: cfg.context });
      const schedulable = (nodes.items ?? []).filter(n => n.spec?.unschedulable !== true);
      return [clusterName, {
        schedulableNodeCount: schedulable.length,
        nodes: schedulable.map(n => ({
          name: n.metadata?.name,
          allocatableCpuMillicores: _cpuToMillicores(n.status?.allocatable?.cpu),
          allocatableMemoryMi:      _memToMi(n.status?.allocatable?.memory),
        })),
      }];
    } catch (err) {
      console.warn(`[PLANNER] node capacity fetch failed for cluster "${clusterName}": ${err.message}`);
      return [clusterName, null];
    }
  }));
  return new Map(entries);
}

// Deterministic per-issue context — recent-deployment correlation, capacity trend, and
// real cluster capacity — the old (legacy) per-incident Planner wiring fetched and
// consumed some of this; it's gathered once here (this file is now the single call
// site) instead of once per incident in graph.js's old loop. All three sources already
// degrade to null on their own (disabled feature flag, fetch failure), so failures here
// are non-fatal.
async function _gatherPlanningContext(issues, clusterConfigs) {
  const clusterNames = [...new Set(issues.map(i => i.clusterName).filter(Boolean))];
  const nodeCapacityByCluster = await _gatherNodeCapacity(clusterConfigs, clusterNames);

  return Promise.all(issues.map(async issue => {
    const changeCorrelation = await ChangeCorrelationEngine.correlate({
      issue, detectedAt: new Date(), eventsJson: { items: [] }, podMetrics: null,
      semanticMatches: [], nodeIssues: [], rolloutHistory: null,
    }).catch(() => null);

    // Each issue's own cluster now, not one shared clusterConfig.name — issues in the
    // same planning batch can come from different clusters.
    const capacityForecast = issue.podName
      ? await CapacityForecastEngine.getPodForecast(issue.clusterName, issue.podName).catch(() => null)
      : null;

    return {
      issueKey: _issueKey(issue), changeCorrelation, capacityForecast,
      nodeCapacity: nodeCapacityByCluster.get(issue.clusterName) ?? null,
    };
  }));
}

// A scope:"cluster" issue (or any issue genuinely missing every identifying field) has
// no nodeName/deployment/podName to build a target name from — `?? null` here used to
// reach PlanStepSchema as a literal null, which fails schema validation (target.name
// requires a string) and crashes the whole workflow before it ever reaches Guardian/
// Policy/escalation. Confirmed live (2026-09-04): a scope:"cluster" incident with no
// identity at all hit exactly this, every cycle, forever, invisible except for one ERROR
// log line. issueKey() always returns a stable, non-null string (worst case
// "<cluster>/default/unknown") — not a real kubectl target, but a safe placeholder that
// still uniquely identifies the issue and lets the plan validate, route to escalation
// like any other command-less step, and stop crashing.
function _targetFor(issue) {
  return {
    kind: issue.nodeName && !issue.podName ? 'Node' : issue.deployment ? 'Deployment' : 'Pod',
    name: issue.nodeName ?? issue.deployment ?? issue.podName ?? _issueKey(issue),
    namespace: issue.namespace ?? 'default',
  };
}

function _fallbackPlan(issues) {
  const steps = issues.map(issue => ({
    action: 'noop',
    command: '',
    target: _targetFor(issue),
    reason: 'planning unavailable — manual inspection required',
    risk: 'medium',
    reversible: true,
    inverseCommand: null,
    issueKeys: [_issueKey(issue)],
  }));
  return PlanSchema.parse({ steps, nonReversible: false });
}

// §Fix-PlannerConfidenceGate (2026-08-31) — deterministic check, not a prompt rule: this
// pipeline has repeatedly found that a prompt-level instruction alone doesn't reliably
// hold once a model is willing to write a plausible-sounding plan anyway (see graph.js's
// guardianNode §Fix-P8 for the identical lesson on Guardian). Confirmed live: the Planner
// proposed a confident, specific-sounding action even when `rca.confidence` was 0
// ("CrashLoopBackOff — investigation unavailable, unable to determine specific root
// cause") — nothing was stopping it from inventing a fix for a diagnosis it didn't
// actually have, and the invented fix sometimes happened to work by luck (the persona's
// generic remedy) and sometimes didn't. Below the threshold, skip the LLM planning loop
// entirely — there's no real diagnosis to plan against — and return a command-less plan
// so it routes straight to escalation instead of guessing.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// Pure predicate, split out from Planner.plan() so both the "should skip" and "should NOT
// skip" behavior are unit-testable without an LLM call — Planner.plan()'s non-gated path
// goes straight to a real network call, which isn't something to exercise from a unit test.
function _isConfidenceTooLowToPlan(confidence) {
  return (confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD;
}

function _lowConfidencePlan(issues, confidence) {
  const steps = issues.map(issue => ({
    action: 'no automated fix available (investigation confidence too low)',
    command: '',
    target: _targetFor(issue),
    reason: `Investigator's confidence (${confidence}) is below ${LOW_CONFIDENCE_THRESHOLD} — there's no real root cause to act on, so no command is safe to propose. Escalate for manual diagnosis instead of guessing.`,
    risk: 'medium',
    reversible: true,
    inverseCommand: null,
    issueKeys: [_issueKey(issue)],
  }));
  return PlanSchema.parse({ steps, nonReversible: false });
}

// `diagnostics` (DIAGNOSTIC, noop-repro investigation 2026-09-11 — easy to remove: just
// delete every line/param marked DIAGNOSTIC in this file and the noop_origin/
// planner_input/tools_available fields in graph.js's plannerNode) is an optional,
// caller-owned object this function only ever WRITES to at points that already exist —
// it does not read from it, branch on it, or change any existing condition/return
// value. Lets an external caller (Planner.plan() below) recover WHICH of several
// same-shaped code paths actually ran (e.g. "hit the iteration cap" and "an LLM call
// errored" both fall through to the identical return-null path today, indistinguishable
// from the outside) without altering the paths themselves.
async function _runPlanningLoop({ issues, rca, clusterConfigs, previousAttemptFailure = null }, diagnostics = {}) {
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];
  const modelWithTools = baseLlm.bindTools([
    _buildDryRunTool(clusterConfigs), _buildEvidenceTool(clusterConfigs), _buildSubmitTool(),
  ]);

  const planningContext = await _gatherPlanningContext(issues, clusterConfigs);
  // §Fix-RetryContext (2026-09-14) — only present on a retry (graph.js's plannerNode
  // reads it off WorkflowState.lastAttemptFailure), so a first attempt's payload is
  // byte-for-byte unchanged. See SYSTEM_PROMPT's paragraph on "previousAttempt" for how
  // the model is told to use it.
  const plannerInputPayload = {
    issues, clusters: clusterNames, investigation: rca, planningContext,
    ...(previousAttemptFailure ? { previousAttempt: previousAttemptFailure } : {}),
  };

  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(JSON.stringify(plannerInputPayload)),
  ];

  // DIAGNOSTIC — the literal payload the LLM receives, and the fixed tool vocabulary
  // available for this call (not case-dependent, but recorded per-call for a caller that
  // has no other way to know it without reading this file).
  diagnostics.plannerInput = plannerInputPayload;
  diagnostics.toolsAvailable = ['dry_run_step', 'gather_more_evidence', SUBMIT_TOOL_NAME];

  // Measurement (Phase 1) — same pattern as investigator.js's commandLog/turnsUsed:
  // toolCallLog records what actually ran (not model self-report), turnsUsed counts
  // LLM calls (one per loop turn) so callers don't need to re-derive it from the cap.
  let turnsUsed = 0;
  const toolCallLog = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    turnsUsed = i + 1;
    let response;
    try {
      response = await runStructuredLLMCall(() => modelWithTools.invoke(messages));
    } catch (err) {
      console.warn(`[PLANNER][${clusterNames.join(',')}] loop call failed (iteration ${i + 1}): ${err.message}`);
      // DIAGNOSTIC — distinguishes this from the "exhausted all iterations" case below,
      // which falls through to the same `return null` otherwise.
      diagnostics.stopReason = err.name === 'CircuitOpenError' ? 'llm_circuit_open' : 'llm_error';
      diagnostics.lastError  = err.message;
      break;
    }
    messages.push(response);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push(new HumanMessage(
        `Please call dry_run_step or gather_more_evidence to keep working, or ${SUBMIT_TOOL_NAME} when your plan is ready.`
      ));
      continue;
    }

    // §7.1 — same reasoning as investigator.js: run every tool call from one LLM turn
    // concurrently (e.g. dry-running two independent steps at once) rather than one at a
    // time. Still one LLM call per turn — only the tool execution overlaps.
    let submission = null;
    const dryRunTool = _buildDryRunTool(clusterConfigs);
    const toolMessages = [];
    await Promise.all(toolCalls.map(async call => {
      if (call.name === SUBMIT_TOOL_NAME) { submission = call; return; }

      // §Fix-PlannerToolCrash (2026-09-11) — dry_run_step's `.invoke()` validates
      // call.args against its zod schema (including the clusterName enum) BEFORE
      // entering the function body; a failure there throws synchronously, uncaught,
      // straight out of this Promise.all and past _runPlanningLoop entirely, landing in
      // Planner.plan()'s outer catch — which discards every iteration already spent and
      // falls back to a noop plan. Confirmed live (noop-repro, 2026-09-11): crashloop-dep
      // and exit127-dep both lost their first attempt this way. Mirrors the recovery
      // pattern already used for a bad submit_plan below — catch, tell the model what was
      // wrong via a normal ToolMessage, let the loop continue instead of aborting.
      if (call.name === 'dry_run_step') {
        try {
          const result = await dryRunTool.invoke(call.args);
          toolCallLog.push({ name: call.name, clusterName: call.args?.clusterName, command: call.args?.command ?? null });
          toolMessages.push(new ToolMessage({ content: String(result), tool_call_id: call.id }));
        } catch (err) {
          toolCallLog.push({ name: call.name, clusterName: call.args?.clusterName, command: call.args?.command ?? null, error: err.message });
          toolMessages.push(new ToolMessage({ content: `ERROR: dry_run_step call did not match the required schema: ${err.message}`, tool_call_id: call.id }));
        }
        return;
      }

      if (call.name === 'gather_more_evidence') {
        try {
          const cfg = clusterConfigs[call.args?.clusterName];
          const result = cfg
            ? await investigator.executeReadOnlyCommand(call.args?.command, cfg.context)
            : `ERROR: unknown clusterName "${call.args?.clusterName}" — must be one of: ${Object.keys(clusterConfigs).join(', ')}`;
          toolCallLog.push({ name: call.name, clusterName: call.args?.clusterName, command: call.args?.command ?? null });
          toolMessages.push(new ToolMessage({ content: String(result), tool_call_id: call.id }));
        } catch (err) {
          toolCallLog.push({ name: call.name, clusterName: call.args?.clusterName, command: call.args?.command ?? null, error: err.message });
          toolMessages.push(new ToolMessage({ content: `ERROR: gather_more_evidence call failed: ${err.message}`, tool_call_id: call.id }));
        }
        return;
      }
    }));
    messages.push(...toolMessages);

    if (!submission) continue;

    try {
      const steps = submission.args.steps.map(s => PlanStepSchema.parse(s));
      const plan  = PlanSchema.parse({ steps, nonReversible: steps.some(s => !s.reversible) });
      console.log(`[PLANNER][${clusterNames.join(',')}] plan accepted — ${plan.steps.length} step(s): ${plan.steps.map(s => s.action).join(' → ')}`);
      // DIAGNOSTIC — a normal, deliberate completion (the model itself decided this
      // plan, including any step with an intentionally empty command — see the
      // SYSTEM_PROMPT's "leave command EMPTY" instruction).
      diagnostics.stopReason = 'submitted';
      // Measurement (Phase 1) — additive, non-schema field; PlanSchema.parse() calls
      // elsewhere (graph.js's policyNode builds its own fresh plan object) never see or
      // round-trip this, so it can't leak into anything re-validated against PlanSchema.
      return { ...plan, _meta: { turnsUsed, toolCallLog, diagnostics } };
    } catch (err) {
      // DIAGNOSTIC — doesn't stop the loop (existing `continue` is unchanged), just
      // records the last schema failure in case the loop never recovers from it.
      diagnostics.lastSchemaError = err.message;
      messages.push(new ToolMessage({ content: `ERROR: plan did not match the required schema: ${err.message}`, tool_call_id: submission.id }));
      continue;
    }
  }

  console.warn(`[PLANNER][${clusterNames.join(',')}] hit the ${MAX_TOOL_ITERATIONS}-iteration safety cap without a valid submission`);
  // DIAGNOSTIC — only set if an earlier branch (llm_error/llm_circuit_open above) hasn't
  // already claimed this run; that break() falls through to this exact same line, so
  // without this guard a real llm_error would get mislabeled as max_iterations.
  diagnostics.stopReason = diagnostics.stopReason ?? 'max_iterations';
  return null;
}

class Planner {
  // `previousAttemptFailure` (§Fix-RetryContext, 2026-09-14, optional) — a plain string
  // describing what the last attempt for this exact issue tried and why it didn't work
  // (graph.js's plannerNode passes WorkflowState.lastAttemptFailure straight through).
  // Folded into the LLM payload so a retry can adjust instead of re-deriving the same
  // guess blind — see _runPlanningLoop.
  //
  // §Fix-PlannerConfidenceGateABTest (Phase 5, 2026-09-18) — `opts.forceCall` (default
  // false) exists ONLY for scripts/ab-test-planner-confidence-gate.js's comparison
  // harness: it bypasses the low-confidence gate below so arm B ("always call the
  // Planner") can be measured against arm A (this method's normal, unchanged default
  // behavior) on the same fixtures. graph.js's plannerNode never passes this — the
  // production gate stays exactly as it was, unless/until real comparative evidence
  // from that harness justifies changing the DEFAULT (see the architecture review's
  // Phase 5 section: your own benchmark data already shows a false-positive-action
  // failure mode this gate exists to prevent, so the default is not changed here).
  async plan(issues, rca, clusterConfigs, previousAttemptFailure = null, opts = {}) {
    const confidence = rca?.confidence ?? 0;
    // DIAGNOSTIC — see _runPlanningLoop's own comment; passed through and attached to
    // whichever plan object actually gets returned below, regardless of which branch.
    const diagnostics = {};
    if (_isConfidenceTooLowToPlan(confidence) && !opts.forceCall) {
      console.warn(`[PLANNER] investigation confidence ${confidence} below ${LOW_CONFIDENCE_THRESHOLD} — skipping planning, no automated fix without a real diagnosis`);
      diagnostics.stopReason = 'low_confidence'; // DIAGNOSTIC
      const plan = _lowConfidencePlan(issues, confidence);
      return { ...plan, _meta: { turnsUsed: 0, toolCallLog: [], diagnostics } };
    }
    const plan = await _runPlanningLoop({ issues, rca, clusterConfigs, previousAttemptFailure }, diagnostics).catch(err => {
      console.warn(`[PLANNER] planning failed: ${err.message}`);
      diagnostics.stopReason = 'planning_exception'; // DIAGNOSTIC
      diagnostics.lastError  = err.message;           // DIAGNOSTIC
      return null;
    });
    if (plan) return { ...plan, _meta: { ...plan._meta, diagnostics } };
    return { ..._fallbackPlan(issues), _meta: { turnsUsed: 0, toolCallLog: [], diagnostics } };
  }
}

module.exports = new Planner();
// Exported for unit testing §Fix-PlannerConfidenceGate in isolation, without needing a
// live LLM call — same pattern as investigator.js's _isReadOnlyCommand export.
module.exports._lowConfidencePlan = _lowConfidencePlan;
module.exports._isConfidenceTooLowToPlan = _isConfidenceTooLowToPlan;
// graph.js substitutes this when the planner service itself is unreachable (remote mode).
module.exports._fallbackPlan = _fallbackPlan;
// Exported for unit testing §Fix-CapacityEvidence's resource-quantity parsing in
// isolation — pure functions, no LLM/kubectl call needed to exercise them.
module.exports._cpuToMillicores = _cpuToMillicores;
module.exports._memToMi = _memToMi;
module.exports.LOW_CONFIDENCE_THRESHOLD = LOW_CONFIDENCE_THRESHOLD;
