'use strict';
require('dotenv').config({ override: true });
const { z }           = require('zod');
const { ChatOpenAI }  = require('@langchain/openai');
const { tool }        = require('@langchain/core/tools');
const { SystemMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
// Reflexion is reached through its client so it can run as its own service
// (AGENT_REFLECTION_MODE=remote) — in-process otherwise, same as before.
const { reflectionClient } = require('./agentClients');
const shortMemory     = require('../memory/shortMemory');
const tokenStore      = require('../api/tokenStore');
const { loadConfig }  = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { InvestigationReportSchema } = require('../orchestrator/schemas');
const { issueKey: _issueKey } = require('../orchestrator/issueKey');

// ── Investigator ─────────────────────────────────────────────────────────────
// Standalone from the rest of the v5 pipeline on purpose (architecture-doc §3.2):
// its only external dependencies are kubectl (tools), config (env), ReflectionAgent
// (the sole gateway to historical incidents/rules — §3.7), and Short Memory (live
// investigation state) — all plain function-call boundaries today, so this file can
// become its own process later with only its transport layer changing.
//
// The legacy src/agents/investigatorAgent.js is untouched — it still serves
// ClusterAgent's pipeline (no longer reachable from the main entrypoint, but its
// files are untouched).
//
// §Fix-ConvergenceSimplification (2026-09-18) — this file previously layered a
// ring-based scoping ladder (investigatorRings.js) and a hypothesis-convergence
// tracker (investigatorConvergence.js) on top of the base loop: a separate
// `submit_ring_assessment` checkpoint tool, a hard gate blocking
// `submit_investigation_report` until a ring assessment cleared a SEPARATE
// (0.85) confidence threshold, and code-computed "is this hypothesis better than
// the last one" / "does this final answer regress from the tracked best" checks.
// That was three deterministic layers deciding WHEN the model was allowed to
// conclude, on top of the base confidence/evidenceSufficiency gate. Removed after
// the architecture review's Phase 7 (regression tests added first — see
// scripts/verify-investigator-loop.js and investigatorConvergence.test.js, both
// passing against the prior implementation before this rewrite) confirmed the
// intended target shape:
//   LLM decides:  DIAGNOSIS_READY (call submit_investigation_report whenever it
//                 believes it has enough) / INVESTIGATE_MORE (keep calling the
//                 read-only tool) — no more separate checkpoint tool or hard
//                 ring-unlock gate standing between the model and its own belief
//                 that it's done.
//   Code enforces: the existing self-report ceiling (confidence AND
//                 evidenceSufficiency >= CONFIDENCE_TARGET, checked against the
//                 PARSED value, not trusted blindly), a NEW minimum-evidence floor
//                 (at least one real, non-dedup tool call must have actually run
//                 before ANY submission is accepted — closes a real gap: nothing
//                 previously stopped a zero-evidence submission from being
//                 accepted purely on an inflated self-reported score), a NEW
//                 evidence-QUALITY floor (the final report's own `evidence` array
//                 must cite something concrete, reusing the same narrow
//                 generic-evidence regex the old ring-assessment gate used — the
//                 backstop against "the pod seems unhealthy"-style filler is kept,
//                 just applied to the one real submission gate instead of a
//                 removed intermediate checkpoint), the existing turn cap
//                 (SAFETY_MAX_ITERATIONS), and a NEW wall-clock cap
//                 (SAFETY_MAX_DURATION_MS) — "maximum duration" was named in the
//                 target architecture and wasn't previously enforced at all
//                 (only turn COUNT was).
// The 11-layer taxonomy (CANONICAL_LAYERS) is unaffected — it was always for
// CLASSIFYING findings, never for restricting investigation order, so removing
// the ring ladder (which WAS about order) doesn't touch it.
//
// Retrieves NO evidence automatically. It starts with only the bare incident
// description + historical context, and gathers everything else itself, on demand,
// via the read-only execution layer below — deciding what to look at, how many times,
// and when it has enough, rather than following a fixed checklist of layers.

const _config = loadConfig();
const INVESTIGATOR_API_KEY  = _config.INVESTIGATOR_API_KEY  || _config.OPENAI_API_KEY;
const INVESTIGATOR_BASE_URL = _config.INVESTIGATOR_BASE_URL || _config.OPENAI_BASE_URL;
const INVESTIGATOR_MODEL    = _config.INVESTIGATOR_MODEL    || _config.OPENAI_MODEL;

const baseLlm = new ChatOpenAI({
  apiKey: INVESTIGATOR_API_KEY,
  model:  INVESTIGATOR_MODEL,
  configuration: INVESTIGATOR_BASE_URL ? { baseURL: INVESTIGATOR_BASE_URL } : undefined,
  temperature: 0.1,
});

const usingDedicated = !!(_config.INVESTIGATOR_API_KEY && _config.INVESTIGATOR_MODEL);
console.log(`[INVESTIGATOR] LLM: ${usingDedicated ? `dedicated (${INVESTIGATOR_MODEL})` : `shared fallback (${INVESTIGATOR_MODEL})`}`);

const CONFIDENCE_TARGET      = 0.5; // both confidence AND evidenceSufficiency must clear this
const SAFETY_MAX_ITERATIONS  = 40;  // runaway-protection ceiling on TURN COUNT, NOT a normal
                                     // operating limit — a well-evidenced investigation should
                                     // converge well before this
const SAFETY_MAX_DURATION_MS = Number(process.env.INVESTIGATOR_MAX_DURATION_MS ?? 10 * 60 * 1000); // 10 min wall-clock ceiling
const MIN_REAL_TOOL_CALLS_BEFORE_SUBMIT = 1; // a submission with zero real evidence gathered is never accepted, regardless of self-reported confidence
const SUBMIT_TOOL_NAME       = 'submit_investigation_report';

// Reference taxonomy (architecture-doc §3.2) for CLASSIFYING findings, not a checklist
// gating what the model may go inspect, and not (since §Fix-ConvergenceSimplification)
// tied to any ring/order concept either — the execution layer below is, and always
// was, fully free-form regardless of this list. Kept as plain strings (not a zod enum)
// on InvestigationReportSchema.layer/perLayerFindings so the model can name a layer
// outside this list when a finding genuinely doesn't fit one of the 11 — "add further
// layers dynamically when the incident requires it," per the report.
const CANONICAL_LAYERS = [
  ['application', 'app logs, crashes, exit codes'],
  ['image',       'image pull errors, registry, tags'],
  ['pod',         'pod lifecycle, probes, restarts'],
  ['controller',  'Deployments, StatefulSets, ReplicaSets'],
  ['network',     'Services, DNS, ingress, CNI'],
  ['storage',     'PV/PVC, volume mounts, capacity'],
  ['config',      'ConfigMaps, Secrets, env vars'],
  ['rbac',        'roles, bindings, service accounts'],
  ['node',        'node pressure, taints, kubelet'],
  ['api',         'API server availability, admission'],
  ['cloud',       'cloud provider resources, quotas'],
];
const LAYER_LIST_TEXT = CANONICAL_LAYERS.map(([name, desc]) => `  ${name} — ${desc}`).join('\n');

// §Fix-ConvergenceSimplification — moved in from the retired investigatorRings.js
// (that file's only other exports were ring-ladder plumbing that no longer has a
// caller). A narrow, cheap backstop against the specific known failure mode the
// original design called out ("the pod seems unhealthy") — not a general-purpose
// evidence-quality classifier. Same pattern as graph.js's RESOLUTION_CLAIM_PATTERN/
// EXTERNAL_OUTAGE_ROOT_CAUSE_RE: a prompt-only instruction to "cite concrete
// evidence" is not trusted to hold on its own in this codebase's experience, so a
// narrow deterministic pattern catches the common vague-filler phrasing without
// trying to fully judge evidence quality in code. Applied below directly against the
// FINAL submission's own `evidence` array (InvestigationReportSchema), since there is
// no more separate ring-assessment checkpoint to apply it to.
const GENERIC_EVIDENCE_RE = /^(the\s+)?(pod|node|service|deployment|container|app|application|workload|resource)?\s*(seems|looks|appears|is)\s+(unhealthy|wrong|broken|off|bad|not\s+right|fine|okay|ok)\.?$/i;

function _isGenericEvidence(entry) {
  const text = String(entry ?? '').trim();
  if (text.length < 15) return true; // too short to be citing anything concrete
  return GENERIC_EVIDENCE_RE.test(text);
}

function _hasConcreteEvidence(evidence) {
  return Array.isArray(evidence) && evidence.length > 0 && evidence.every(e => !_isGenericEvidence(e));
}

const SYSTEM_PROMPT = `You are a Kubernetes root-cause investigator.
You start with NO evidence — only the bare incident description(s) and any historical
context below. You may be given more than one incident at once — they were grouped
because they landed in the same namespace in the same cycle, which often (not always)
means a shared root cause or a cascading failure between related apps. That namespace
may exist in more than one cluster — each incident carries its own "clusterName", so
check it rather than assuming they're all from the same cluster. Investigate them
together: look for relationships between them, and say so explicitly if you find one
(e.g. "B's crash is downstream of A's earlier failure", or "the same bad image is
failing the same way in both cluster X and cluster Y — likely one shared rollout, not
two independent incidents"). If they turn out to be unrelated, that's a fine conclusion
too — say that instead of forcing a connection.
Use "componentsInvolved" to attribute your findings to the specific incident(s) each
one applies to. You have two tools:

- run_readonly_kubectl_command: run any READ-ONLY kubectl command to gather evidence.
  Pass "clusterName" (one of the clusters listed for you below) to say which cluster to
  run it against — you can freely inspect any of them, including cross-checking the
  same resource across two clusters, in whatever order you need. You decide what to
  inspect, in what order, and how many times — there is no fixed sequence or checklist
  to follow. Call it as many times as you need, one command per call, and re-check
  anything you already looked at if it might have changed. It will refuse anything that
  isn't a read; do not attempt write commands. Every call also requires "reasoning": a
  short sentence on why THIS command, right now — what you already know and what you
  expect it to tell you. Think this through before picking the command, not after —
  "reasoning" is not a caption for a command you'd already decided to run.

- ${SUBMIT_TOOL_NAME}: submit your final structured findings. Call this whenever YOU
  believe you have enough evidence to conclude — there is no separate checkpoint to
  clear first. Only call it once you are genuinely confident — your "confidence" (how
  sure you are about the root cause) AND your "evidenceSufficiency" (how complete/solid
  the evidence backing it is) must BOTH be at least ${CONFIDENCE_TARGET}. If you submit
  below that bar, or before gathering any real evidence at all, or without citing
  anything concrete, you will be told and asked to keep investigating. Do not inflate
  either score to end the investigation early — an honest lower score that keeps you
  gathering more evidence is correct behavior, not a failure. This tool also requires:
  "severity": your OWN assessment (low/medium/high/critical) of how serious this issue
    actually is, based on the real evidence you gathered — not a repeat of whatever
    severity the original incident report guessed at before any investigation happened.
    A CrashLoopBackOff that turns out to be a cosmetic logging bug is not the same
    severity as one that's silently corrupting writes; say which this is.
  "reasoning": why you believe THIS conclusion is right and why NOW is the right time to
    submit rather than keep gathering evidence — distinct from "rootCause" (which states
    WHAT the cause is, not why you're confident enough to stop looking).
  "evidence": the concrete findings (exact log lines, event reasons, field values) that
    back your conclusion — a vague restatement like "the pod seems unhealthy" is not
    acceptable and will be rejected back to you.

ALREADY RESOLVED IS A VALID CONCLUSION: the incident may no longer be reproducing by the
time you look — signals get investigated some time after they fired. If your OWN evidence
(current pod status/phase, ready state, recent logs) contradicts the original incident
description, that contradiction IS your root cause. Report it plainly (e.g. rootCause:
"issue no longer reproducing — pod is currently healthy and ready") with high confidence,
rather than continuing to search for a root cause that isn't there anymore. Do not let the
original incident description bias you into assuming something is still broken.

EFFICIENT EVIDENCE GATHERING: when narrowing an already-broad result (e.g. events on a
resource), run the unfiltered/broad query FIRST and read what it actually returns,
rather than guessing at specific --field-selector values one call at a time — most
possible values (e.g. Node-condition event reasons like NodeMemoryPressure,
NodeShutdown, NodeReady) simply don't apply to a Pod-scoped incident, and guessing
through a list of them individually burns iterations without turning up anything new.
Only add a filter once a broader query has shown you there's something specific worth
narrowing down to. Before calling a command, check whether you've already run this exact
command (or a trivially rephrased equivalent) earlier in this investigation — if the
answer wouldn't have changed, don't repeat it; either try something genuinely different
or submit with the evidence you already have.

LAYER CLASSIFICATION — your report's "layer" field, and each entry in
"perLayerFindings", must name which layer of the Kubernetes stack the finding belongs
to. Use one of these 11 when it genuinely fits:
${LAYER_LIST_TEXT}
If a finding doesn't fit any of these, name a new layer yourself rather than forcing a
bad fit — this list is a reference for classification, not a restriction on what you can
call something or what you're allowed to go inspect, and not a required order to
investigate them in.

Each "perLayerFindings" entry also needs:
  status:      "healthy" (nothing wrong here), "warning" (minor/inconclusive concern),
               "critical" (this layer is where the problem lives), or "unknown" (not
               inspected / couldn't tell) — a downstream reviewer should be able to see
               your investigation's shape from these statuses alone, without reading
               "summary".
  commandsRun: which of your run_readonly_kubectl_command calls (verbatim command text)
               fed this specific finding — only the ones actually relevant to it, not
               every command you ran overall.

Do not fabricate evidence you were not given by a tool call.

If the input includes "fastPathContext", a lightweight fast-path check already ran
before you did: it gathered the fields under "evidenceAlreadyGathered" and produced
"priorDiagnosis" from them, but wasn't confident enough to stop there. Treat that
evidence as ALREADY KNOWN — don't re-run the same describe/logs/get calls it already
made unless you have a specific reason to believe something changed since. You may
agree with, refine, or fully overturn "priorDiagnosis" — it is a starting point for
your own investigation, not a conclusion you are obligated to defend.

If the input includes "previousAttemptFailure", an automated fix was already attempted
for this EXACT issue and it did not work (it names the command that was tried and why it
was rejected or didn't verify fixed). This is real, relevant evidence — for example a
command that ran but didn't resolve it may mean your root-cause diagnosis needs to change,
not just that a different command should be tried for the same cause. Take it into account
rather than re-investigating as if this were the first attempt.`;

// ── Read-only execution layer ────────────────────────────────────────────────
// The allowlist gate itself lives in src/tools/readOnlyKubectl.js (shared with the
// k8s-read gateway service). Every read this agent makes goes through the k8s-read
// client, so with AGENT_K8S_READ_MODE=remote this process never touches cluster
// credentials at all — the gateway does, after re-running the same gate.
const { _isReadOnlyCommand } = require('../tools/readOnlyKubectl');
const { k8sRead } = require('../tools/k8sGateway');

// Never throws — same contract as before the gateway existed: a failure comes back as an
// "ERROR: ..." tool result the model can read and react to. That now also covers mesh
// transport failures (gateway down/timeout, refused context), which would otherwise
// reject the whole turn's Promise.all in _runInvestigationLoop / Planner / Fast Path.
async function executeReadOnlyCommand(argsStr, context) {
  try {
    return await k8sRead.exec({ command: argsStr, context });
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

// `clusterConfigs` is the fleet map { [clusterName]: { context, tier, ... } } for every
// cluster this investigation may need to touch. The model picks a clusterName per call
// from a z.enum of the REAL, known cluster names — it never supplies a raw context/
// kubeconfig value itself, so the safety property from before (the model can't redirect
// a command at an arbitrary cluster) holds exactly as it did with a single fixed
// context: it's just choosing which known cluster now, instead of there being only one.
function _buildReadOnlyTool(clusterConfigs) {
  const clusterNames = Object.keys(clusterConfigs);
  return tool(
    async ({ clusterName, command }) => {
      const cfg = clusterConfigs[clusterName];
      if (!cfg) return `ERROR: unknown clusterName "${clusterName}" — must be one of: ${clusterNames.join(', ')}`;
      return executeReadOnlyCommand(command, cfg.context);
    },
    {
      name: 'run_readonly_kubectl_command',
      description: 'Run a READ-ONLY kubectl command to gather diagnostic evidence. ' +
        `Set "clusterName" to which cluster to run it against (one of: ${clusterNames.join(', ')}). ` +
        'Provide only the subcommand and arguments — do NOT include "kubectl" or "--context". ' +
        'Example: "get pods -n default -o json" or "describe pod api-1 -n default". Only ' +
        'get/describe/logs/top/explain/api-resources/api-versions/version/cluster-info are permitted; ' +
        'anything else is rejected. "reasoning" is required: think through why this specific command, ' +
        'right now, BEFORE picking it — what you already know and what you expect it to tell you.',
      schema: z.object({
        clusterName: z.enum(clusterNames.length ? clusterNames : ['unknown']),
        command: z.string().describe('kubectl subcommand and arguments, without "kubectl" or "--context"'),
        reasoning: z.string().describe('Why this command, right now — what you already know and what you expect it to tell you.'),
      }),
    }
  );
}

// The "finish" tool — its arguments ARE the final report. No real side effect; the loop
// below intercepts the call and decides whether to accept it (confidence AND
// evidenceSufficiency both >= CONFIDENCE_TARGET, at least one real command already run,
// and the cited evidence isn't generic filler) or reject it back to the model with an
// explanation, via the normal tool-result channel, same as any other tool call.
function _buildSubmitTool() {
  return tool(
    async (args) => JSON.stringify(args),
    {
      name: SUBMIT_TOOL_NAME,
      description: `Submit your final investigation report. Only call this once confidence AND ` +
        `evidenceSufficiency are both >= ${CONFIDENCE_TARGET}, you've gathered at least some real ` +
        `evidence, and you can cite something concrete; otherwise keep investigating first.`,
      schema: InvestigationReportSchema,
    }
  );
}

// _issueKey imported above from ../orchestrator/issueKey — shared with
// orchestratorAgent.js/graph.js/planner.js instead of reimplemented independently.

function _fallback(issues) {
  const primary = issues[0];
  const type = primary.type ?? 'Unknown';
  const cause = primary.oomKilled || primary.exitCode === 137
    ? `OOMKilled — container exceeded memory limit (exit code ${primary.exitCode ?? 137})`
    : `${type} — investigation unavailable, unable to determine specific root cause`;
  return {
    rootCause: cause, layer: 'pod', symptom: type,
    componentsInvolved: issues.map(i => i.deployment ?? i.podName ?? i.nodeName).filter(Boolean),
    confidence: 0, evidence: [], recommendedFocus: 'manual inspection required', riskLevel: 'medium',
    layersInspected: [], perLayerFindings: [], evidenceSufficiency: 0,
    // No real investigation happened (thrown error, or the loop never got a usable
    // submission) — severity/reasoning can't be genuinely assessed, so this stays a
    // clearly-labeled placeholder rather than a guessed value dressed up as real judgment.
    severity: 'medium',
    reasoning: 'investigation unavailable — no evidence was gathered, this is a placeholder, not an assessment',
    suspected_cause: cause, recommended_focus: 'manual inspection required', risk_level: 'medium',
    // Honest empty/derived defaults for the observability fields WorkflowTracer/Mongo
    // schema still read (see §Fix-ConvergenceSimplification) — no ring investigation
    // happened at all here (the loop never ran or threw before producing anything).
    layersInvestigated: [], investigationExhausted: true, investigationTurns: 0,
    stoppingOutcome: 'INCONCLUSIVE',
  };
}

// ── The investigation loop ──────────────────────────────────────────────────────
// Starts with zero evidence. Every iteration the model either calls
// run_readonly_kubectl_command (gather more) or submit_investigation_report (finish) —
// a submission is only accepted once it clears all three deterministic floors below
// (real evidence exists, evidence is concrete, confidence/evidenceSufficiency both meet
// the bar); otherwise it's rejected back to the model as a normal tool result and the
// loop continues. Bounded by SAFETY_MAX_ITERATIONS (turn count) and
// SAFETY_MAX_DURATION_MS (wall clock) purely as runaway guards — the model itself
// decides when it's ready to conclude; these never intervene before that point.
// §Fix-4 (2026-08-28) — the exact-string repeat key below missed a real class of
// duplicates: the model re-asking the SAME query with cosmetically different quoting
// (e.g. -o jsonpath='{.spec...}' vs -o jsonpath={.spec...}). Confirmed live: single
// cycles racked up 15-40 back-to-back repeats of what was functionally one query because
// each quote variant looked like a "new" command to the old exact-match key. Stripping
// quotes and collapsing whitespace before comparing catches that without needing to
// understand kubectl's own quoting rules.
function _normalizeCommandForDedup(command) {
  return String(command || '').replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

// LangChain's ChatOpenAI reports usage on the response message rather than via the
// raw OpenAI stream shape (usage_metadata.{input,output,total}_tokens, or the older
// response_metadata.tokenUsage.{prompt,completion,total}Tokens) — neither matches
// tokenStore.record's expected {prompt_tokens, completion_tokens, total_tokens},
// which mirrors the raw OpenAI SDK usage object the other agents pass in directly.
function _extractUsage(response) {
  const um = response?.usage_metadata;
  if (um) {
    return {
      prompt_tokens:     um.input_tokens  ?? 0,
      completion_tokens: um.output_tokens ?? 0,
      total_tokens:      um.total_tokens  ?? 0,
    };
  }
  const tu = response?.response_metadata?.tokenUsage;
  if (tu) {
    return {
      prompt_tokens:     tu.promptTokens     ?? 0,
      completion_tokens: tu.completionTokens ?? 0,
      total_tokens:      tu.totalTokens      ?? 0,
    };
  }
  return null;
}

async function _runInvestigationLoop({ issues, clusterConfigs, reflexionContext, seed, previousAttemptFailure, signal }) {
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];
  const commandLog = [];
  // Counts repeats per normalized command, across the WHOLE investigation (not reset
  // per-turn) — lets the short-circuit message escalate from a gentle nudge to a hard
  // stop once a command has clearly stopped producing new information.
  const repeatCounts = new Map();
  const readOnlyTool   = _buildReadOnlyTool(clusterConfigs);
  const submitTool     = _buildSubmitTool();
  const modelWithTools = baseLlm.bindTools([readOnlyTool, submitTool]);

  // Phase 2 (Fast Path) — `seed` is only ever present when this investigation is
  // resuming after a fast-path escalation (see graph.js's investigatorNode), and only
  // ever for a length-1 `issues` array (a SIMPLE incident is always dispatched solo).
  // Handed to the model as "fastPathContext" — see SYSTEM_PROMPT's paragraph on it —
  // so the model has a stated starting hypothesis instead of nothing.
  const fastPathContext = seed
    ? { evidenceAlreadyGathered: seed.evidenceBundle, priorDiagnosis: seed.diagnosis }
    : undefined;

  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    // issues each carry their own clusterName already — no single "cluster" field to
    // pass, just the full list of clusters this investigation may touch.
    new HumanMessage(JSON.stringify({ issues, clusters: clusterNames, historicalContext: reflexionContext, fastPathContext, previousAttemptFailure })),
  ];

  let lastCandidate = null;
  // Every turn of the loop below is exactly one modelWithTools.invoke() call, so this
  // doubles as the LLM-call count for the whole investigation — tracked outside the
  // for-loop (not read from its own scoped `i`) so it's still correct whichever way
  // the loop exits (natural cap, wall-clock cap, or the early `break` on a failed LLM call).
  let turnsUsed = 0;
  let realCommandCount = 0; // §Fix-ConvergenceSimplification — the minimum-evidence floor's counter
  const loopStartedAt = Date.now();

  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    if (Date.now() - loopStartedAt > SAFETY_MAX_DURATION_MS) {
      console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] hit the ${SAFETY_MAX_DURATION_MS}ms wall-clock cap after ${turnsUsed} turn(s) — stopping`);
      break;
    }
    if (signal?.aborted) {
      console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] caller's deadline passed after ${turnsUsed} turn(s) — stopping (${signal.reason?.message ?? 'aborted'})`);
      break;
    }
    turnsUsed = i + 1;

    let response;
    try {
      response = await runStructuredLLMCall(() => modelWithTools.invoke(messages, signal ? { signal } : undefined));
    } catch (err) {
      console.warn(`[INVESTIGATOR] loop call failed (iteration ${i + 1}): ${err.message}`);
      break;
    }
    messages.push(response);
    tokenStore.record('investigator', _extractUsage(response));

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push(new HumanMessage(
        `Please either call run_readonly_kubectl_command to gather more evidence, or ${SUBMIT_TOOL_NAME} once you have enough.`
      ));
      continue;
    }

    // §7.1 — when one LLM turn issues several tool calls at once (e.g. inspecting two
    // clusters' evidence in the same step), run them CONCURRENTLY rather than one at a
    // time — this is still a single agentic loop with one LLM per turn (not 11 parallel
    // LLM threads, the anti-pattern §7.1 warns against), just with the read-only kubectl
    // calls within a turn overlapping. Tool results are matched back to their call by
    // tool_call_id, not by array position, so push order here doesn't need to match
    // toolCalls' order.
    let submission = null;
    const toolMessages = [];
    // Snapshot of everything already run BEFORE this turn — used to short-circuit an
    // exact (post-normalization) repeat instead of re-executing it. Confirmed live
    // (2026-08-28): without this, the model can re-issue the identical command a dozen+
    // times across iterations (e.g. "get namespaces" repeated 15 times in one
    // investigation) while stuck, burning real kubectl round-trips and iteration budget
    // for zero new information — a snapshot taken once per turn (not re-checked
    // mid-batch) is sufficient since same-turn duplicates are rare in practice.
    const alreadyRun = new Set(commandLog.map(c => `${c.clusterName}::${_normalizeCommandForDedup(c.command)}`));
    await Promise.all(toolCalls.map(async call => {
      if (call.name === SUBMIT_TOOL_NAME) { submission = call; return; }

      const repeatKey = `${call.args?.clusterName}::${_normalizeCommandForDedup(call.args?.command)}`;
      let result;
      if (alreadyRun.has(repeatKey)) {
        // §Fix-4 — the first repeat gets a gentle nudge; confirmed live that a single
        // nudge often isn't enough to stop the model re-asking the same thing several
        // more times, so the message escalates to a hard stop from the second repeat on.
        const priorRepeats = repeatCounts.get(repeatKey) ?? 1;
        repeatCounts.set(repeatKey, priorRepeats + 1);
        result = priorRepeats >= 2
          ? `(you have now asked this exact command ${priorRepeats + 1} times in this investigation — the answer will not change. Stop repeating it: run a genuinely different command, or call ${SUBMIT_TOOL_NAME} now with the evidence you already have.)`
          : '(already ran this exact command earlier in this investigation, even if quoted slightly differently — see the earlier result above; try a different command or submit with what you have)';
      } else {
        repeatCounts.set(repeatKey, 1);
        realCommandCount += 1; // §Fix-ConvergenceSimplification — feeds the minimum-evidence floor below
        // Logged BEFORE the command runs — this is the model's own stated reason for
        // picking this command, captured because it's a required tool argument (see
        // _buildReadOnlyTool), not something the prompt merely asks for and hopes holds.
        if (call.args?.reasoning) console.log(`[INVESTIGATOR] [REASONING] ${call.args.reasoning}`);
        const cfg = clusterConfigs[call.args?.clusterName];
        result = cfg
          ? await executeReadOnlyCommand(call.args?.command, cfg.context)
          : `ERROR: unknown clusterName "${call.args?.clusterName}" — must be one of: ${Object.keys(clusterConfigs).join(', ')}`;
      }
      commandLog.push({ clusterName: call.args?.clusterName, command: call.args?.command, reasoning: call.args?.reasoning ?? null, result: result.length > 500 ? result.slice(0, 500) + '...' : result });
      toolMessages.push(new ToolMessage({ content: String(result), tool_call_id: call.id }));
    }));
    messages.push(...toolMessages);

    if (!submission) continue;

    let candidate;
    try {
      candidate = InvestigationReportSchema.parse(submission.args);
    } catch (err) {
      messages.push(new ToolMessage({ content: `ERROR: submission did not match the required schema: ${err.message}`, tool_call_id: submission.id }));
      continue;
    }

    lastCandidate = candidate;

    // §Fix-ConvergenceSimplification — three deterministic floors, checked in order of
    // how fundamental the gap is: no evidence at all, evidence that IS present but is
    // vague filler, then the existing self-reported confidence/evidenceSufficiency
    // ceiling. None of these decide WHAT the root cause is or WHEN the model should
    // feel ready — they only verify objective, checkable facts about what actually
    // happened in this conversation (a real command ran; the cited text isn't a
    // known-vague phrase; the model's own scores clear a bar), same enforcement/
        // decision split as every other floor in this codebase.
    if (realCommandCount < MIN_REAL_TOOL_CALLS_BEFORE_SUBMIT) {
      messages.push(new ToolMessage({
        content: `Not accepted — you haven't gathered any real evidence yet. Call run_readonly_kubectl_command ` +
          `at least once before submitting a report.`,
        tool_call_id: submission.id,
      }));
      continue;
    }
    if (!_hasConcreteEvidence(candidate.evidence)) {
      messages.push(new ToolMessage({
        content: `Not accepted — "evidence" must cite concrete findings (an exact log line, event reason, or ` +
          `field value), not a generic description like "the pod seems unhealthy". Resubmit with specific evidence.`,
        tool_call_id: submission.id,
      }));
      continue;
    }

    const meetsConfidenceGate = candidate.confidence >= CONFIDENCE_TARGET && candidate.evidenceSufficiency >= CONFIDENCE_TARGET;
    if (meetsConfidenceGate) {
      console.log(`[INVESTIGATOR] [REASONING] ${candidate.reasoning}`);
      return { report: candidate, commandLog, reachedTarget: true, turnsUsed };
    }

    messages.push(new ToolMessage({
      content: `Not accepted — confidence=${candidate.confidence.toFixed(2)}, evidenceSufficiency=${candidate.evidenceSufficiency.toFixed(2)}, ` +
        `both must be >= ${CONFIDENCE_TARGET}. Keep investigating with run_readonly_kubectl_command before submitting again.`,
      tool_call_id: submission.id,
    }));
  }

  console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] hit the ${SAFETY_MAX_ITERATIONS}-iteration/${SAFETY_MAX_DURATION_MS}ms safety cap without reaching confidence/evidenceSufficiency >= ${CONFIDENCE_TARGET}`);
  return { report: lastCandidate, commandLog, reachedTarget: false, turnsUsed };
}

// Small local resolver, deliberately not shared with graph.js's _clusterFor — this file
// stays standalone on purpose (see file header), its own external dependencies are
// plain function-call boundaries, not a shared internal helper module.
function _tierFor(clusterConfigs, clusterName) {
  return clusterConfigs?.[clusterName]?.tier ?? 'dev';
}

class Investigator {
  // `issues` is an array — usually one incident, but may be several grouped by
  // namespace (architecture-doc §7.6/§9.1: OrchestratorAgent dispatches one workflow
  // per namespace, not per incident — now potentially spanning clusters too). One
  // agentic loop investigates the whole group together, since this file (unlike the
  // ported Planner/Guardian/Reflection) is where genuine cross-incident (and now
  // cross-cluster) reasoning belongs — see AGENTIC/SYSTEM_PROMPT above.
  // `seed` (Phase 2, optional) — { evidenceBundle, diagnosis } from a fast-path
  // escalation (src/agents/fastPath.js via graph.js's investigatorNode). Only ever
  // present for a length-1 `issues` array; threaded straight through to
  // _runInvestigationLoop, which folds it into the model's initial message as
  // "fastPathContext" (see SYSTEM_PROMPT's paragraph on it) rather than making the
  // model re-gather what Fast Path already found.
  // `previousAttemptFailure` (§Fix-RetryContext, 2026-09-14, optional) — a plain string
  // from graph.js's WorkflowState.lastAttemptFailure, describing what an earlier
  // automated attempt at fixing this exact issue tried and why it didn't work. Only
  // present on a re-diagnose retry; folded into the model's initial message so it can be
  // taken into account rather than re-investigating blind (see SYSTEM_PROMPT's paragraph
  // on it).
  // `signal` (optional) — set when this runs as the investigator service: it aborts at the
  // task's deadline, i.e. once the orchestrator has stopped waiting for this answer, so an
  // abandoned investigation stops spending LLM calls instead of running to completion.
  async investigate(issues, clusterConfigs, seed = null, previousAttemptFailure = null, { signal } = {}) {
    const clusterNames = [...new Set(issues.map(i => i.clusterName))];
    const keys = issues.map(_issueKey);

    await Promise.all(keys.map((key, i) =>
      shortMemory.upsertIncident(key, { stage: 'investigating', issue: issues[i], startedAt: new Date().toISOString() })
    ));

    try {
      // Reflexion context merged across every DISTINCT issue type in the group — a
      // mixed-type group (e.g. CrashLoopBackOff + OOMKilled in the same namespace)
      // gets rules/history for both, not just whichever issue happened to be first.
      // Deliberately NOT cluster-scoped (see reflectionAgent's fingerprint) — a learned
      // rule from one cluster should still surface as relevant history on another.
      const distinctTypes = [...new Set(issues.map(i => i.type))];
      const queryText = issues.map(i => `${i.type} ${i.podName ?? i.nodeName ?? ''} ${i.namespace ?? ''}`).join('; ').trim();
      const contexts = await Promise.all(distinctTypes.map(issueType => {
        const rep = issues.find(i => i.type === issueType);
        const fingerprint = {
          issueType, oomKilled: rep.oomKilled ?? false, exitCode: rep.exitCode ?? null,
          hasDeployment: !!rep.deployment, tier: _tierFor(clusterConfigs, rep.clusterName), imagePrefix: '',
        };
        return reflectionClient.getContext({ fingerprint, queryText, issueType });
      }));
      const reflexionContext = {
        rules:             contexts.flatMap(c => c.rules),
        structuralMatches: contexts.flatMap(c => c.structuralMatches),
        semanticMatches:   contexts.flatMap(c => c.semanticMatches),
      };

      const { report, commandLog, reachedTarget, turnsUsed } =
        await _runInvestigationLoop({ issues, clusterConfigs, reflexionContext, seed, previousAttemptFailure, signal });
      const finalReport = report ?? _fallback(issues);
      if (!reachedTarget) {
        console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] returning best-effort report — never reached the confidence/evidence target (confidence=${finalReport.confidence}, evidenceSufficiency=${finalReport.evidenceSufficiency})`);
      }

      // §Fix-ConvergenceSimplification — honest, lightweight derivations for the
      // observability fields WorkflowTracer/the WorkflowTrace Mongo schema still read
      // (see workflowTracer.js's attachInvestigatorResult, which already treats every
      // one of these as optional via `?? default`) — no ring/convergence machinery
      // computes these anymore, so they're derived directly from what actually
      // happened in this run rather than removed outright, to avoid every historical
      // dashboard field silently going blank.
      const layersInvestigated = [...new Set((finalReport.perLayerFindings ?? []).map(f => f.layer).filter(Boolean))];
      const stoppingOutcome = reachedTarget
        ? 'DIAGNOSIS_READY'
        : ((turnsUsed ?? 0) >= SAFETY_MAX_ITERATIONS ? 'INVESTIGATION_BUDGET_EXHAUSTED' : 'INCONCLUSIVE');

      const result = {
        ...finalReport,
        commandsExecuted: commandLog, // what the execution layer actually ran — not model self-report
        reachedConfidenceTarget: reachedTarget,
        // Legacy-compatible flat fields — PlannerAgent.plan()/GuardianAgent.review()
        // (ported as-is) read these, not the multi-layer shape above.
        suspected_cause:   finalReport.rootCause,
        recommended_focus: finalReport.recommendedFocus,
        risk_level:        finalReport.riskLevel,
        layersInvestigated,
        investigationExhausted: !reachedTarget,
        stoppingOutcome,
        // Measurement (Phase 1) — every loop turn is exactly one LLM call (see
        // _runInvestigationLoop), so this doubles as the investigator's LLM-call count.
        // 0 when investigate() failed before the loop ever ran (see the catch block below).
        investigationTurns: turnsUsed ?? 0,
      };

      console.log(`[INVESTIGATOR][${clusterNames.join(',')}] ${result.rootCause} (layer=${result.layer}, severity=${result.severity}, conf=${result.confidence.toFixed(2)}, evidence=${result.evidenceSufficiency.toFixed(2)}, commands run=${commandLog.length}, incidents=${issues.length})`);

      // Same combined report attached under each incident's own key, so per-app
      // status stays independently readable even though they were investigated as a
      // group — mirrors how graph.js keeps per-item issueTrackerStore keys.
      await Promise.all(keys.map((key, i) =>
        shortMemory.upsertIncident(key, { stage: 'investigated', issue: issues[i], report: result, completedAt: new Date().toISOString() })
      ));
      return result;

    } catch (err) {
      console.warn(`[INVESTIGATOR] Investigation failed: ${err.message}`);
      const fallback = _fallback(issues);
      await Promise.all(keys.map((key, i) =>
        shortMemory.upsertIncident(key, { stage: 'investigation_failed', issue: issues[i], error: err.message }).catch(() => {})
      ));
      return fallback;
    }
  }
}

module.exports = new Investigator();
// Exposed directly (alongside the primary .investigate() API) so the read-only gate —
// the security-critical piece of the execution layer — can be verified on its own,
// without going through a full (LLM-driven) investigation.
module.exports._isReadOnlyCommand    = _isReadOnlyCommand;
// graph.js substitutes this when the investigator service itself is unreachable (remote mode).
module.exports._fallback             = _fallback;
module.exports.executeReadOnlyCommand = executeReadOnlyCommand;
module.exports._hasConcreteEvidence  = _hasConcreteEvidence;
module.exports._isGenericEvidence    = _isGenericEvidence;
// Single source of truth for the 11 canonical layer NAMES.
module.exports.CANONICAL_LAYER_NAMES = CANONICAL_LAYERS.map(([name]) => name);
