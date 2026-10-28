'use strict';
require('dotenv').config({ override: true });
const { ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
const { loadConfig } = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const tokenStore = require('../api/tokenStore');
const { z } = require('zod');

const _config = loadConfig();
const ROOTCAUSEFIT_API_KEY  = _config.ROOTCAUSEFIT_API_KEY  || _config.OPENAI_API_KEY;
const ROOTCAUSEFIT_BASE_URL = _config.ROOTCAUSEFIT_BASE_URL || _config.OPENAI_BASE_URL;
const ROOTCAUSEFIT_MODEL    = _config.ROOTCAUSEFIT_MODEL    || _config.OPENAI_MODEL;

const RootCauseFitSchema = z.object({
  fit: z.enum(['YES', 'NO', 'UNCERTAIN']),
  reason: z.string(),
  evidenceCited: z.array(z.string()).default([]),
});

const assessLlm = new ChatOpenAI({
  apiKey: ROOTCAUSEFIT_API_KEY,
  model:  ROOTCAUSEFIT_MODEL,
  configuration: ROOTCAUSEFIT_BASE_URL ? { baseURL: ROOTCAUSEFIT_BASE_URL } : undefined,
  temperature: 0.1,
}).withStructuredOutput(RootCauseFitSchema, { method: 'functionCalling', includeRaw: true });

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

// Check if the action fits the root cause
async function assessRootCauseFit({ rootCause, command, evidenceSummary }) {
  if (!rootCause || !command) {
    return { fit: 'UNCERTAIN', reason: 'missing rootCause or command to assess', evidenceCited: [] };
  }
  try {
    const userPrompt = `Root cause: ${rootCause}\nEvidence summary: ${evidenceSummary || '(none provided)'}\nProposed command: ${command}`;
    const result = await runStructuredLLMCall(async () => tokenStore.unwrapStructured('rootCauseFit', await assessLlm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userPrompt),
    ])));
    return result;
  } catch (err) {
    console.warn(`[ROOTCAUSEFIT] assessment failed (advisory only, no effect on the actual verdict): ${err.message}`);
    return { fit: 'UNCERTAIN', reason: `assessment unavailable: ${err.message}`, evidenceCited: [] };
  }
}

module.exports = { assessRootCauseFit, RootCauseFitSchema };
