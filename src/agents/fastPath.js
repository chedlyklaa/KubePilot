'use strict';
require('dotenv').config({ override: true });
const { ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
const { z } = require('zod');
const investigator       = require('./investigator');
const { loadConfig }     = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { FastPathDiagnosisSchema, InvestigationReportSchema } = require('../orchestrator/schemas');

// ── Fast Path ────────────────────────────────────────────────────────────────
// For incidents the Orchestrator classified SIMPLE (src/agents/orchestratorAgent.js's
// complexity gate) — a deliberately narrow, bounded alternative to the full
// Investigator (src/agents/investigator.js), whose job is to resolve the common,
// well-understood failure patterns fast instead of paying for a multi-round tool-
// calling loop every time. This file must NEVER become a second unbounded agent loop:
//
//   ONE bounded evidence-selection call (LLM picks ≤ MAX_EVIDENCE_REQUESTS read-only
//   commands, code enforces the cap and the read-only allowlist)  →  execute them  →
//   ONE no-tool diagnosis call  →  accept (proceed to Planner) or escalate (Full
//   Investigator)
//
// §Fix-FastPathBoundedEvidence (Phase 6, 2026-09-18) — before this, evidence gathering
// was a fully deterministic, fixed profile per issue.type (one of 6 hardcoded gather
// functions — a straightforward "issue-type -> tool mapping" the architecture review
// flagged as a semantic decision forced by code). The model now chooses WHICH read-only
// commands to run, reusing the exact same execution layer, allowlist, and secret-value
// block Investigator/Planner already share (investigator.executeReadOnlyCommand) — the
// only thing that changed is WHO decides what to gather, not the deterministic
// boundaries around it (still capped, still read-only, still exactly one diagnosis
// call). The `diagnosisLlm` below still has NO bindTools()/tool schema at all — that
// absence is still the structural guarantee against a second LLM<->tool ReAct loop for
// the DIAGNOSIS phase; the bounded evidence-selection phase is a single structured-
// output call (pick up to N commands), not an iterative loop either, so the total cost
// profile stays exactly 2 LLM calls per incident regardless of complexity, same as
// before this change (previously: 1 gather-free call + 1 diagnosis call; now: 1
// evidence-selection call + 1 diagnosis call).
//
// Measured before this change (see the architecture review's Phase 6 section for the
// full methodology): the fixed-profile version's latency/call-count/accuracy/escalation
// rate on real incidents. Compare against this bounded version using the same
// methodology before treating this as a strict improvement rather than a lateral,
// more-autonomous-but-unproven change.

const _config = loadConfig();
const FASTPATH_API_KEY  = _config.FASTPATH_API_KEY  || _config.OPENAI_API_KEY;
const FASTPATH_BASE_URL = _config.FASTPATH_BASE_URL || _config.OPENAI_BASE_URL;
const FASTPATH_MODEL    = _config.FASTPATH_MODEL    || _config.OPENAI_MODEL;

const diagnosisLlm = new ChatOpenAI({
  apiKey: FASTPATH_API_KEY,
  model:  FASTPATH_MODEL,
  configuration: FASTPATH_BASE_URL ? { baseURL: FASTPATH_BASE_URL } : undefined,
  temperature: 0.1,
}).withStructuredOutput(FastPathDiagnosisSchema, { method: 'functionCalling' });

const usingDedicated = !!(_config.FASTPATH_API_KEY && _config.FASTPATH_MODEL);
console.log(`[FASTPATH] LLM: ${usingDedicated ? `dedicated (${FASTPATH_MODEL})` : `shared fallback (${FASTPATH_MODEL})`}`);

// Lower than Investigator's confidence bar (0.5, investigator.js's CONFIDENCE_TARGET)
// would be backwards — incidents reaching Fast Path are already pre-filtered SIMPLE by
// the Orchestrator's classification AND its deterministic sibling/controller backstop
// (_findOvercalledSimple), so LESS evidence should be needed to be confident, not more;
// kept at its original, higher bar (0.75) since that relationship is about the
// STARTING evidence quality, not about how the evidence was selected — Phase 6 doesn't
// change what "enough evidence" means, only who chooses what to gather.
const FAST_PATH_CONFIDENCE_THRESHOLD = Number(process.env.FAST_PATH_CONFIDENCE_THRESHOLD ?? 0.75);

// The deterministic boundary Phase 6 explicitly keeps: the LLM owns WHICH commands to
// request, code owns HOW MANY it's allowed. Kept small and named, not derived from
// anything — this is the one number that makes "bounded" actually bounded.
const MAX_EVIDENCE_REQUESTS = Number(process.env.FASTPATH_MAX_EVIDENCE_REQUESTS ?? 3);

const EvidenceRequestSchema = z.object({
  commands: z.array(z.object({
    command: z.string().describe('kubectl subcommand and arguments, without "kubectl" or "--context"'),
    reasoning: z.string().describe('why this command, specifically, for this incident'),
  })),
  // No .max() here on purpose — a model that asks for more than MAX_EVIDENCE_REQUESTS
  // should not fail structured-output validation (which would cost a retry round-trip
  // for something code can trivially handle); the cap is enforced deterministically
  // after parsing (see diagnose() below), by simply not running the extra requests.
});

const evidenceSelectionLlm = new ChatOpenAI({
  apiKey: FASTPATH_API_KEY,
  model:  FASTPATH_MODEL,
  configuration: FASTPATH_BASE_URL ? { baseURL: FASTPATH_BASE_URL } : undefined,
  temperature: 0.1,
}).withStructuredOutput(EvidenceRequestSchema, { method: 'functionCalling' });

const EVIDENCE_SELECTION_SYSTEM_PROMPT = `You are selecting evidence for a Kubernetes
incident already classified as SIMPLE — a well-understood, single-resource failure
pattern (CrashLoopBackOff, OOMKilled, ImagePullBackOff, Pending, a missing ConfigMap/
Secret reference, or a probe failure). You will get exactly ONE diagnosis call after
this, using only what you request here — there is no follow-up round, so choose
carefully rather than broadly.

You may request AT MOST ${MAX_EVIDENCE_REQUESTS} read-only kubectl commands. Only
get/describe/logs/top/explain/api-resources/api-versions/version/cluster-info are
permitted — anything else is rejected when it runs, wasting one of your requests. Never
request "get secrets"/"get secret <name>" — Secret values are never allowed through
regardless of what you ask for.

Prefer the smallest set of commands that would actually settle the diagnosis for THIS
specific incident type, not a generic checklist — e.g. a CrashLoopBackOff usually needs
current + previous logs and a describe; an ImagePullBackOff usually needs the pod's
current status and whether its imagePullSecrets actually exist; a Pending pod usually
needs a describe (for scheduling-failure events) and node conditions. If you genuinely
believe zero additional commands are needed (the incident summary you were given is
already enough), return an empty list rather than requesting something unhelpful just
to use your budget.`;

function _settledValue(result, label) {
  if (result.status === 'fulfilled') return result.value;
  console.warn(`[FASTPATH] [EVIDENCE] ${label} failed: ${result.reason?.message}`);
  return null;
}

// Adapts an accepted Fast Path diagnosis into the exact shape plannerNode/guardianNode
// already consume (InvestigationReportSchema + the legacy flat fields investigator.js's
// own investigate() wrapper adds) — see that file's `result` construction for the
// pattern this mirrors.
function _toInvestigationReport(diagnosis, issue, evidenceBundle) {
  // §Fix-FastPathBoundedEvidence — layer is now the model's own self-report (see
  // FastPathDiagnosisSchema.layer), not a deterministic lookup from a fixed profile
  // name, since there's no fixed profile left to look up. 'application' is the same
  // fallback default the old PROFILE_LAYER table used most often.
  const layer = diagnosis.layer || 'application';
  const evidenceSufficiency = diagnosis.evidenceSufficient ? diagnosis.confidence : 0;
  return {
    rootCause: diagnosis.rootCause,
    layer,
    symptom: issue.type,
    componentsInvolved: [issue.deployment ?? issue.podName ?? issue.nodeName].filter(Boolean),
    confidence: diagnosis.confidence,
    evidence: diagnosis.supportingEvidence,
    recommendedFocus: diagnosis.missingInformation.length ? diagnosis.missingInformation.join('; ') : 'none — evidence sufficient',
    riskLevel: diagnosis.severity,
    layersInspected: [layer],
    perLayerFindings: [{ layer, status: 'critical', summary: diagnosis.rootCause, commandsRun: (evidenceBundle.results ?? []).map(r => r.command) }],
    evidenceSufficiency,
    severity: diagnosis.severity,
    reasoning: diagnosis.reasoning,
    // Legacy-compatible flat fields — PlannerAgent.plan()/GuardianAgent.review() (ported
    // as-is) read these, not the multi-layer shape above.
    suspected_cause:   diagnosis.rootCause,
    recommended_focus: diagnosis.missingInformation.length ? diagnosis.missingInformation.join('; ') : 'none',
    risk_level:        diagnosis.severity,
    layersInvestigated: [layer],
    investigationTurns: 1 + (evidenceBundle.results?.length ?? 0), // 1 selection call + N executed reads (diagnosis call counted by the caller)
    commandsExecuted: (evidenceBundle.results ?? []).map(r => ({ command: r.command, reasoning: r.reasoning, result: r.result })),
    reachedConfidenceTarget: true,
    investigationExhausted: false,
    stoppingOutcome: 'DIAGNOSIS_READY',
    // Marks this rca as Fast-Path-produced — not part of InvestigationReportSchema
    // (additive), used for observability/debugging only, no downstream code branches on it.
    fastPath: true,
  };
}

class FastPath {
  // Returns { escalate, reason, evidenceBundle, diagnosis, toolCallCount }.
  // `escalate: true` means "the Full Investigator should run instead" — for every
  // reason (unresolvable cluster, gather failure, LLM-call failure, or a genuine
  // model self-report that the evidence isn't enough) the caller (graph.js's
  // fastPathNode) treats it identically: fall through to the Full Investigator, never
  // straight to Planner and never straight to Human — a Fast Path failure just means
  // "no fast-path evidence exists," which is exactly the Full Investigator's job.
  async diagnose(issue, clusterConfigs) {
    if (!issue.podName) {
      return { escalate: true, reason: 'no podName on a SIMPLE incident — cannot select a pod-scoped evidence bundle', evidenceBundle: null, diagnosis: null, toolCallCount: 0 };
    }
    const cfg = clusterConfigs?.[issue.clusterName];
    if (!cfg?.context) {
      console.warn(`[FASTPATH] no clusterConfig for "${issue.clusterName}" — refusing to guess a context`);
      return { escalate: true, reason: `unknown cluster "${issue.clusterName}"`, evidenceBundle: null, diagnosis: null, toolCallCount: 0 };
    }

    // ── Phase 1: bounded evidence selection — LLM chooses WHAT, code enforces HOW MANY ──
    let requested;
    try {
      const selection = await runStructuredLLMCall(() => evidenceSelectionLlm.invoke([
        new SystemMessage(EVIDENCE_SELECTION_SYSTEM_PROMPT),
        new HumanMessage(JSON.stringify({ issue })),
      ]));
      requested = (selection.commands ?? []).slice(0, MAX_EVIDENCE_REQUESTS);
    } catch (err) {
      console.warn(`[FASTPATH] evidence selection failed: ${err.message}`);
      return { escalate: true, reason: `evidence selection failed: ${err.message}`, evidenceBundle: null, diagnosis: null, toolCallCount: 0 };
    }

    // ── Phase 2: execute the (capped) requested commands via the shared read-only
    // execution layer — same allowlist/sanitizer/secret-value block Investigator and
    // Planner already use, so a model requesting a write command or "get secrets" is
    // rejected exactly the same way there, not a separately-maintained check here.
    const settled = await Promise.allSettled(
      requested.map(r => investigator.executeReadOnlyCommand(r.command, cfg.context))
    );
    const results = requested.map((r, i) => ({
      command: r.command, reasoning: r.reasoning,
      result: _settledValue(settled[i], r.command) ?? `ERROR: ${settled[i].reason?.message ?? 'unknown failure'}`,
    }));

    const evidenceBundle = {
      profile: 'llm-selected', incidentType: issue.type, podName: issue.podName,
      namespace: issue.namespace ?? 'default', clusterName: issue.clusterName, results,
    };

    // ── Phase 3: exactly one no-tool diagnosis call — unchanged from before Phase 6.
    let diagnosis;
    try {
      diagnosis = await runStructuredLLMCall(() => diagnosisLlm.invoke([
        new SystemMessage(DIAGNOSIS_SYSTEM_PROMPT),
        new HumanMessage(JSON.stringify({ issue, evidence: evidenceBundle })),
      ]));
    } catch (err) {
      console.warn(`[FASTPATH] diagnosis call failed: ${err.message}`);
      return { escalate: true, reason: `diagnosis call failed: ${err.message}`, evidenceBundle, diagnosis: null, toolCallCount: results.length };
    }

    const sufficient = diagnosis.evidenceSufficient === true
      && diagnosis.confidence >= FAST_PATH_CONFIDENCE_THRESHOLD
      && diagnosis.requiresDeepInvestigation === false;

    console.log(`[FASTPATH][${issue.clusterName}] requested ${requested.length} evidence request(s), ${diagnosis.rootCause} (confidence=${diagnosis.confidence.toFixed(2)}, evidenceSufficient=${diagnosis.evidenceSufficient}, requiresDeepInvestigation=${diagnosis.requiresDeepInvestigation}) → ${sufficient ? 'SUFFICIENT' : 'escalating'}`);

    return {
      escalate: !sufficient,
      reason: sufficient ? null : 'below fast-path confidence/evidence bar, or the model itself requested deep investigation',
      evidenceBundle, diagnosis, toolCallCount: results.length,
    };
  }

  // Adapter exposed separately from diagnose() (rather than folded into it) so
  // graph.js's fastPathNode controls exactly when/whether the InvestigationReportSchema
  // shape gets built and validated — diagnose() itself stays a pure "should we stop
  // here" decision, without also being responsible for the downstream schema contract.
  toInvestigationReport(diagnosis, issue, evidenceBundle) {
    const rca = _toInvestigationReport(diagnosis, issue, evidenceBundle);
    try { InvestigationReportSchema.parse(rca); }
    catch (err) { console.warn(`[FASTPATH] adapted report failed schema validation: ${err.message}`); }
    return rca;
  }
}

const DIAGNOSIS_SYSTEM_PROMPT = `You are a Kubernetes fast-path diagnostician.
You are given ONE incident, already classified as a SIMPLE, well-understood failure
pattern, plus a BOUNDED bundle of evidence — gathered per your own (or a prior call's)
request, up to ${MAX_EVIDENCE_REQUESTS} read-only commands — before this call. You have
no tool available here and cannot request anything else now. Decide, from this evidence
alone, whether the root cause is clear enough to act on now, or whether this needs the
full multi-round Investigator instead.

Do not invent evidence you were not given. If the bundle is inconclusive, say so
honestly — "evidenceSufficient": false and/or "requiresDeepInvestigation": true are the
correct, EXPECTED answer for a real fraction of incidents; that is this fast path
correctly recognizing its own limits, not a failure.

If the input includes "fastPathContext" — it won't, in this call; that field only
appears when the FULL Investigator resumes after a fast-path escalation — ignore it here.

Return:
  rootCause:                 what you believe is actually wrong, one or two sentences.
  confidence:                0-1, how sure you are about rootCause.
  supportingEvidence:        concrete citations from the evidence bundle (an exact log
                              line, event reason, or field value) — never a vague
                              restatement like "the pod seems unhealthy".
  alternativeHypotheses:     other plausible causes you considered, and why you ruled
                              them out (or didn't) — empty only if truly none occurred
                              to you.
  missingInformation:        what you would check next if you were NOT stopping here —
                              used to seed the full Investigator if this escalates, so
                              be specific (a command/resource/layer, not "more info").
  evidenceSufficient:        true only if the bundle actually supports rootCause with no
                              important gap.
  requiresDeepInvestigation: true if this genuinely needs more than this bounded bundle
                              can tell you.
  severity:                  your OWN assessment (low/medium/high/critical) from the
                              real evidence — not a repeat of the original guess.
  layer:                     which part of the Kubernetes stack this belongs to (e.g.
                              application, image, pod, controller, network, storage,
                              config, rbac, node, api) — your best classification.
  reasoning:                 why you believe this conclusion, and why (or why not) this
                              bundle is enough to stop here.`;

module.exports = new FastPath();
module.exports.FAST_PATH_CONFIDENCE_THRESHOLD = FAST_PATH_CONFIDENCE_THRESHOLD;
module.exports.MAX_EVIDENCE_REQUESTS = MAX_EVIDENCE_REQUESTS;
// Exposed for unit testing in isolation, same pattern as investigator.js's
// _isReadOnlyCommand / planner.js's _isConfidenceTooLowToPlan exports.
module.exports._toInvestigationReport = _toInvestigationReport;
