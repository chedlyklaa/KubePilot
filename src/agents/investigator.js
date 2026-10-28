'use strict';
require('dotenv').config({ override: true });
const { z }           = require('zod');
const { ChatOpenAI }  = require('@langchain/openai');
const { tool }        = require('@langchain/core/tools');
const { SystemMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const kubectl         = require('../tools/kubectl');
const reflectionAgent = require('./reflectionAgent');
const shortMemory     = require('../memory/shortMemory');
const tokenStore      = require('../api/tokenStore');
const PolicyEngine    = require('../policy/policyEngine');
const { loadConfig }  = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { InvestigationReportSchema } = require('../orchestrator/schemas');
const { issueKey: _issueKey } = require('../orchestrator/issueKey');
const { filterToolOutput, truncateToolOutput, withDefaultLogTail, compactToolHistory } = require('./contextBudget');

const policyEngine = new PolicyEngine();

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

const CONFIDENCE_TARGET      = 0.5;
const SAFETY_MAX_ITERATIONS  = 40;
const SAFETY_MAX_DURATION_MS = Number(process.env.INVESTIGATOR_MAX_DURATION_MS ?? 10 * 60 * 1000);
const MIN_REAL_TOOL_CALLS_BEFORE_SUBMIT = 1;
const SUBMIT_TOOL_NAME      = 'submit_investigation_report';

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

const GENERIC_EVIDENCE_RE = /^(the\s+)?(pod|node|service|deployment|container|app|application|workload|resource)?\s*(seems|looks|appears|is)\s+(unhealthy|wrong|broken|off|bad|not\s+right|fine|okay|ok)\.?$/i;

function _isGenericEvidence(entry) {
  const text = String(entry ?? '').trim();
  if (text.length < 15) return true;
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

KEEP OUTPUTS SMALL: every result stays in your context for the rest of the investigation,
and results are capped at a few thousand characters (longer ones are cut in the middle).
Prefer targeted commands: -o jsonpath='{...}' or -o custom-columns=... when you need
specific fields; "logs --tail=100" (add --previous for a crash-looping container);
"get events --field-selector type=Warning --sort-by=.lastTimestamp" over a broad events
dump; describe/-o yaml on ONE named resource, never on a whole resource type. Older
results may later be shortened to their first and last lines — re-run a command if you
need its full output again.

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
rather than re-investigating as if this were the first attempt.

If the input includes "previousFindings", that earlier attempt's investigation already
established these facts: its root cause, the evidence behind it, the commands it ran
("commandsAlreadyRun") and the status of each layer it checked. Do not re-run those
commands just to see the same output again — only re-check something if it may have
changed since (e.g. after a fix was applied) or if you need a detail not captured here.
The earlier root cause MAY BE WRONG: the fix built on it did not work. Use
"previousAttemptFailure" to judge whether the diagnosis itself needs to change, and spend
your commands on what the earlier attempt did NOT look at.`;

const READONLY_VERBS = new Set([
  'get', 'describe', 'logs', 'top', 'explain',
  'api-resources', 'api-versions', 'version', 'cluster-info',
]);
const BLOCKED_FLAGS_RE = /(^|\s)(-f|--follow|-w|--watch)(\s|=|$)/;
const BLOCKED_RESOURCE_RE = /^secrets?$/i;

function _isReadOnlyCommand(argsStr) {
  const trimmed = (argsStr ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty command' };

  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0];
  if (!READONLY_VERBS.has(verb)) {
    return { ok: false, reason: `verb "${verb}" is not on the read-only allowlist (${[...READONLY_VERBS].join(', ')})` };
  }
  if (BLOCKED_FLAGS_RE.test(` ${trimmed} `)) {
    return { ok: false, reason: 'streaming flags (-f/--follow/-w/--watch) are not allowed' };
  }
  const resourceTypes = tokens.slice(1)
    .filter(t => !t.startsWith('-'))
    .flatMap(t => t.split(',').map(x => x.split('/')[0]));
  if (resourceTypes.some(t => BLOCKED_RESOURCE_RE.test(t))) {
    return { ok: false, reason: 'reading Secret values is blocked — use the Config-layer summary (key names only) instead' };
  }
  return { ok: true };
}

// Run a read-only kubectl command
async function executeReadOnlyCommand(argsStr, context) {
  const gate = _isReadOnlyCommand(argsStr);
  if (!gate.ok) {
    console.warn(`[INVESTIGATOR] [EXEC-LAYER] blocked: "${argsStr}" — ${gate.reason}`);
    return `ERROR: command blocked — ${gate.reason}`;
  }

  const fullCommand = `kubectl --context=${context} ${withDefaultLogTail(argsStr)}`;
  const { safe, command, reason } = policyEngine.sanitizeCommand(fullCommand);
  if (!safe) {
    console.warn(`[INVESTIGATOR] [EXEC-LAYER] blocked by sanitizer: "${argsStr}" — ${reason}`);
    return `ERROR: command blocked — ${reason}`;
  }

  try {
    console.log(`[INVESTIGATOR] [EXEC-LAYER] running: ${command}`);
    const out = await kubectl.runCommand(command);
    return truncateToolOutput(argsStr, filterToolOutput(argsStr, out));
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

// Build the read-only kubectl tool
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

// Build the submit report tool
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

// Fallback report when investigation fails
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
    severity: 'medium',
    reasoning: 'investigation unavailable — no evidence was gathered, this is a placeholder, not an assessment',
    suspected_cause: cause, recommended_focus: 'manual inspection required', risk_level: 'medium',
    layersInvestigated: [], investigationExhausted: true, investigationTurns: 0,
    stoppingOutcome: 'INCONCLUSIVE',
  };
}

// Normalize a command for duplicate detection
function _normalizeCommandForDedup(command) {
  return String(command || '').replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

const PRIOR_EVIDENCE_LIMIT = 8;
const PRIOR_COMMAND_LIMIT  = 15;

function summarizeFindings(rca) {
  if (!rca?.rootCause) return null;
  const commands = [...new Set((rca.commandsExecuted ?? []).map(c => c?.command).filter(Boolean))];
  if (!commands.length && !(rca.evidence ?? []).length) return null;
  const layersChecked = Object.fromEntries(
    (rca.perLayerFindings ?? []).filter(f => f?.layer).map(f => [f.layer, f.status ?? 'unknown'])
  );
  return {
    rootCause:          rca.rootCause,
    layer:              rca.layer ?? null,
    evidence:           (rca.evidence ?? []).slice(0, PRIOR_EVIDENCE_LIMIT),
    commandsAlreadyRun: commands.slice(0, PRIOR_COMMAND_LIMIT),
    layersChecked,
  };
}

async function _runInvestigationLoop({ issues, clusterConfigs, reflexionContext, seed, previousAttemptFailure, previousFindings }) {
  const clusterNames = [...new Set(issues.map(i => i.clusterName))];
  const commandLog = [];
  const repeatCounts = new Map();
  const fullResults = new Map();
  let promptTokens = 0;
  const readOnlyTool   = _buildReadOnlyTool(clusterConfigs);
  const submitTool     = _buildSubmitTool();
  const modelWithTools = baseLlm.bindTools([readOnlyTool, submitTool]);

  const fastPathContext = seed
    ? { evidenceAlreadyGathered: seed.evidenceBundle, priorDiagnosis: seed.diagnosis }
    : undefined;

  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(JSON.stringify({ issues, clusters: clusterNames, historicalContext: reflexionContext, fastPathContext, previousAttemptFailure, previousFindings: previousFindings ?? undefined })),
  ];

  let lastCandidate = null;
  let turnsUsed = 0;
  let realCommandCount = 0;
  const loopStartedAt = Date.now();

  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    if (Date.now() - loopStartedAt > SAFETY_MAX_DURATION_MS) {
      console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] hit the ${SAFETY_MAX_DURATION_MS}ms wall-clock cap after ${turnsUsed} turn(s) — stopping`);
      break;
    }
    turnsUsed = i + 1;

    const compacted = compactToolHistory(messages);
    if (compacted) console.log(`[INVESTIGATOR] [CONTEXT] compacted ${compacted} older tool result(s) before turn ${i + 1}`);

    let response;
    try {
      response = await runStructuredLLMCall(() => modelWithTools.invoke(messages));
    } catch (err) {
      console.warn(`[INVESTIGATOR] loop call failed (iteration ${i + 1}): ${err.message}`);
      break;
    }
    messages.push(response);
    const usage = tokenStore.usageFrom(response);
    tokenStore.record('investigator', usage);
    promptTokens += usage?.prompt_tokens ?? 0;
    if (usage) console.log(`[INVESTIGATOR] [TOKENS] turn ${i + 1}: input=${usage.prompt_tokens} (cached=${usage.cached_tokens}) output=${usage.completion_tokens}`);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push(new HumanMessage(
        `Please either call run_readonly_kubectl_command to gather more evidence, or ${SUBMIT_TOOL_NAME} once you have enough.`
      ));
      continue;
    }

    let submission = null;
    const toolMessages = [];
    const alreadyRun = new Set(commandLog.map(c => `${c.clusterName}::${_normalizeCommandForDedup(c.command)}`));
    await Promise.all(toolCalls.map(async call => {
      if (call.name === SUBMIT_TOOL_NAME) { submission = call; return; }

      const repeatKey = `${call.args?.clusterName}::${_normalizeCommandForDedup(call.args?.command)}`;
      let result;
      if (alreadyRun.has(repeatKey)) {
        const priorRepeats = repeatCounts.get(repeatKey) ?? 1;
        repeatCounts.set(repeatKey, priorRepeats + 1);
        result = priorRepeats >= 2
          ? `(you have now asked this exact command ${priorRepeats + 1} times in this investigation — the answer will not change. Stop repeating it: run a genuinely different command, or call ${SUBMIT_TOOL_NAME} now with the evidence you already have.)`
          : '(already ran this exact command earlier in this investigation, even if quoted slightly differently — its result is repeated below and will not change; try a different command next, or submit with what you have)' +
            (fullResults.has(repeatKey) ? `\n\n${fullResults.get(repeatKey)}` : '');
      } else {
        repeatCounts.set(repeatKey, 1);
        realCommandCount += 1;
        if (call.args?.reasoning) console.log(`[INVESTIGATOR] [REASONING] ${call.args.reasoning}`);
        const cfg = clusterConfigs[call.args?.clusterName];
        result = cfg
          ? await executeReadOnlyCommand(call.args?.command, cfg.context)
          : `ERROR: unknown clusterName "${call.args?.clusterName}" — must be one of: ${Object.keys(clusterConfigs).join(', ')}`;
        fullResults.set(repeatKey, result);
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
      return { report: candidate, commandLog, reachedTarget: true, turnsUsed, promptTokens };
    }

    messages.push(new ToolMessage({
      content: `Not accepted — confidence=${candidate.confidence.toFixed(2)}, evidenceSufficiency=${candidate.evidenceSufficiency.toFixed(2)}, ` +
        `both must be >= ${CONFIDENCE_TARGET}. Keep investigating with run_readonly_kubectl_command before submitting again.`,
      tool_call_id: submission.id,
    }));
  }

  console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] hit the ${SAFETY_MAX_ITERATIONS}-iteration/${SAFETY_MAX_DURATION_MS}ms safety cap without reaching confidence/evidenceSufficiency >= ${CONFIDENCE_TARGET}`);
  return { report: lastCandidate, commandLog, reachedTarget: false, turnsUsed, promptTokens };
}

// Get the tier of a cluster
function _tierFor(clusterConfigs, clusterName) {
  return clusterConfigs?.[clusterName]?.tier ?? 'dev';
}

class Investigator {
  // Investigate one or more issues
  async investigate(issues, clusterConfigs, seed = null, previousAttemptFailure = null, previousFindings = null) {
    const clusterNames = [...new Set(issues.map(i => i.clusterName))];
    const keys = issues.map(_issueKey);

    await Promise.all(keys.map((key, i) =>
      shortMemory.upsertIncident(key, { stage: 'investigating', issue: issues[i], startedAt: new Date().toISOString() })
    ));

    try {
      const distinctTypes = [...new Set(issues.map(i => i.type))];
      const queryText = issues.map(i => `${i.type} ${i.podName ?? i.nodeName ?? ''} ${i.namespace ?? ''}`).join('; ').trim();
      const contexts = await Promise.all(distinctTypes.map(issueType => {
        const rep = issues.find(i => i.type === issueType);
        const fingerprint = {
          issueType, oomKilled: rep.oomKilled ?? false, exitCode: rep.exitCode ?? null,
          hasDeployment: !!rep.deployment, tier: _tierFor(clusterConfigs, rep.clusterName), imagePrefix: '',
        };
        return reflectionAgent.getContext({ fingerprint, queryText, issueType });
      }));
      const reflexionContext = {
        rules:             contexts.flatMap(c => c.rules),
        structuralMatches: contexts.flatMap(c => c.structuralMatches),
        semanticMatches:   contexts.flatMap(c => c.semanticMatches),
      };

      const { report, commandLog, reachedTarget, turnsUsed, promptTokens } =
        await _runInvestigationLoop({ issues, clusterConfigs, reflexionContext, seed, previousAttemptFailure, previousFindings });
      const finalReport = report ?? _fallback(issues);
      if (!reachedTarget) {
        console.warn(`[INVESTIGATOR][${clusterNames.join(',')}] returning best-effort report — never reached the confidence/evidence target (confidence=${finalReport.confidence}, evidenceSufficiency=${finalReport.evidenceSufficiency})`);
      }

      const layersInvestigated = [...new Set((finalReport.perLayerFindings ?? []).map(f => f.layer).filter(Boolean))];
      const stoppingOutcome = reachedTarget
        ? 'DIAGNOSIS_READY'
        : ((turnsUsed ?? 0) >= SAFETY_MAX_ITERATIONS ? 'INVESTIGATION_BUDGET_EXHAUSTED' : 'INCONCLUSIVE');

      const result = {
        ...finalReport,
        commandsExecuted: commandLog,
        reachedConfidenceTarget: reachedTarget,
        suspected_cause:   finalReport.rootCause,
        recommended_focus: finalReport.recommendedFocus,
        risk_level:        finalReport.riskLevel,
        layersInvestigated,
        investigationExhausted: !reachedTarget,
        stoppingOutcome,
        investigationTurns: turnsUsed ?? 0,
      };

      console.log(`[INVESTIGATOR][${clusterNames.join(',')}] ${result.rootCause} (layer=${result.layer}, severity=${result.severity}, conf=${result.confidence.toFixed(2)}, evidence=${result.evidenceSufficiency.toFixed(2)}, commands run=${commandLog.length}, incidents=${issues.length}, turns=${turnsUsed}, prompt tokens=${promptTokens})`);

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
module.exports._isReadOnlyCommand    = _isReadOnlyCommand;
module.exports.executeReadOnlyCommand = executeReadOnlyCommand;
module.exports._hasConcreteEvidence  = _hasConcreteEvidence;
module.exports._isGenericEvidence    = _isGenericEvidence;
module.exports.summarizeFindings     = summarizeFindings;
module.exports.CANONICAL_LAYER_NAMES = CANONICAL_LAYERS.map(([name]) => name);
