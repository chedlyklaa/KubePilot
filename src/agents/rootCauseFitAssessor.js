'use strict';
require('dotenv').config({ override: true });
const { ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
const { loadConfig } = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { z } = require('zod');

// ── Root-cause fit assessor (Phase 4 experiment, 2026-09-18) ─────────────────────
// ADVISORY ONLY — this module's result is logged/traced but MUST NEVER be used to
// gate, override, or replace any verdict. It exists to collect real comparison data
// against `_actionCannotAddressRootCause` (graph.js's regex-based root-cause/action
// compatibility check) per the architecture review's Phase 4 experiment design:
//
//   1. Run this in parallel with the regex, on every Guardian review, logged not enforced.
//   2. Build a regression set from the two confirmed-live incidents that motivated the
//      regex (a nil-pointer-dereference diagnosis approved for a plain restart; a
//      confirmed third-party outage approved for a restart) plus the dual-cluster
//      benchmark's known cases, plus synthetic cases the regex is known to be blind to.
//   3. Compare: does this call's verdict match the historically-correct outcome?
//   4. Only promote this from "advisory" to "the actual gate" once it matches or beats
//      the regex's own track record AND generalizes to the regex's known blind spots.
//   5. If promoted, the regex STAYS as a deterministic backstop — never fully replaced.
//
// The regex (`_actionCannotAddressRootCause`, graph.js) remains the sole ENFORCED gate
// until that promotion criterion is met with real data — this file changes nothing
// about production behavior on its own.

const _config = loadConfig();
const ROOTCAUSEFIT_API_KEY  = _config.ROOTCAUSEFIT_API_KEY  || _config.OPENAI_API_KEY;
const ROOTCAUSEFIT_BASE_URL = _config.ROOTCAUSEFIT_BASE_URL || _config.OPENAI_BASE_URL;
const ROOTCAUSEFIT_MODEL    = _config.ROOTCAUSEFIT_MODEL    || _config.OPENAI_MODEL;

const RootCauseFitSchema = z.object({
  fit: z.enum(['YES', 'NO', 'UNCERTAIN']),
  reason: z.string(),
  // Mirrors GuardianVerdictSchema.evidenceCited's confabulation-guard pattern: forces
  // the model to point at something concrete rather than asserting a mismatch (or a
  // fit) ungrounded — same lesson this codebase has already learned from Guardian's
  // own evidenceCited field.
  evidenceCited: z.array(z.string()).default([]),
});

const assessLlm = new ChatOpenAI({
  apiKey: ROOTCAUSEFIT_API_KEY,
  model:  ROOTCAUSEFIT_MODEL,
  configuration: ROOTCAUSEFIT_BASE_URL ? { baseURL: ROOTCAUSEFIT_BASE_URL } : undefined,
  temperature: 0.1,
}).withStructuredOutput(RootCauseFitSchema);

const SYSTEM_PROMPT = `You are assessing ONE narrow question: does the MECHANISM of a
proposed kubectl command plausibly address the stated root cause?

You are not judging whether the command is safe, well-scoped, or syntactically correct —
only whether, if it ran successfully, it could actually fix the described problem.

Answer NO when the command's mechanism cannot possibly touch the root cause — for
example: restarting or deleting a pod cannot fix a code-level bug (a panic, a nil
pointer dereference, a logic error) that will simply recur in the new process; no
kubectl command can fix a confirmed external/third-party outage or provider-wide
disruption; a plain restart cannot fix a resource-limit problem (OOM) that will
recur immediately.

Answer YES when the command's mechanism is a genuinely plausible fix for the stated
cause — for example: rolling back after a bad deployment, raising a memory limit for
an OOM, restarting after a transient dependency failure that has since recovered,
patching a misconfigured field.

Answer UNCERTAIN only when you genuinely cannot tell from the given root cause and
evidence — not as a default hedge.

Return your answer with "reason" (one or two sentences) and "evidenceCited" — the
specific phrases from the root cause or evidence text your answer is actually based on;
if you can't point to anything, that's a sign your answer isn't grounded, and you
should answer UNCERTAIN instead of guessing.`;

// Never throws — a failure here must never break or delay the review it's advisory
// to. Fails to UNCERTAIN (not YES or NO), matching the honest "couldn't assess this"
// meaning, since nothing downstream ever gates on this result today.
async function assessRootCauseFit({ rootCause, command, evidenceSummary }) {
  if (!rootCause || !command) {
    return { fit: 'UNCERTAIN', reason: 'missing rootCause or command to assess', evidenceCited: [] };
  }
  try {
    const userPrompt = `Root cause: ${rootCause}\nEvidence summary: ${evidenceSummary || '(none provided)'}\nProposed command: ${command}`;
    const result = await runStructuredLLMCall(() => assessLlm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userPrompt),
    ]));
    return result;
  } catch (err) {
    console.warn(`[ROOTCAUSEFIT] assessment failed (advisory only, no effect on the actual verdict): ${err.message}`);
    return { fit: 'UNCERTAIN', reason: `assessment unavailable: ${err.message}`, evidenceCited: [] };
  }
}

module.exports = { assessRootCauseFit, RootCauseFitSchema };
