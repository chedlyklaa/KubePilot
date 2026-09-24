'use strict';

/**
 * LLM Circuit Breaker
 *
 * Wraps a streaming LLM call with:
 *   - Per-attempt timeout  (LLM_TIMEOUT_MS env var, default 30 s)
 *   - Exponential-backoff retry  (max 3 attempts, delays 1 s → 2 s)
 *   - Required-field JSON validation on the collected response
 *
 * Controlled by FALLBACK_ENABLED env var:
 *   FALLBACK_ENABLED=true  → full circuit-breaker behaviour; throws CircuitOpenError
 *                            on exhaustion so the caller can activate its fallback.
 *   FALLBACK_ENABLED=false (default) → transparent passthrough; errors propagate
 *                            exactly as before — development behaviour unchanged.
 */

const FALLBACK_ENABLED = process.env.FALLBACK_ENABLED === 'true';
const TIMEOUT_MS       = parseInt(process.env.LLM_TIMEOUT_MS ?? '30000', 10);
const MAX_ATTEMPTS     = 3;

// Canonical failure reasons — carried on CircuitOpenError and forwarded into the
// fallback plan so they appear in the existing audit trail unchanged.
const REASON = {
  TIMEOUT:          'llm_timeout',
  UNAVAILABLE:      'llm_unavailable',
  INVALID_RESPONSE: 'invalid_response',
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyError(err) {
  if (err.name === 'TimeoutError')         return REASON.TIMEOUT;
  if (err.name === 'InvalidResponseError') return REASON.INVALID_RESPONSE;
  const msg = err.message?.toLowerCase() ?? '';
  if (msg.includes('timeout') || msg.includes('timed out') || err.code === 'ETIMEDOUT')
    return REASON.TIMEOUT;
  return REASON.UNAVAILABLE;
}

// Race any promise against a wall-clock timeout — shared by the streaming collector
// and the plain-Promise structured-output path.
function _raceTimeout(promise, timeoutMs) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`LLM call timed out after ${timeoutMs}ms`);
      e.name  = 'TimeoutError';
      reject(e);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

// Collect all chunks from an OpenAI streaming call into { raw, usage },
// racing against a wall-clock timeout.
function collectWithTimeout(createStreamFn, timeoutMs) {
  return _raceTimeout((async () => {
    const stream = await createStreamFn();
    let raw = '', usage = null;
    for await (const chunk of stream) {
      raw   += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }
    return { raw, usage };
  })(), timeoutMs);
}

// Verify that raw contains parseable JSON that includes every required field.
// Throws InvalidResponseError (retriable) if the check fails.
function validateRaw(raw, requiredFields) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    const e = new Error('No JSON object found in LLM response');
    e.name  = 'InvalidResponseError';
    throw e;
  }

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch {
    const e = new Error('Malformed JSON in LLM response');
    e.name  = 'InvalidResponseError';
    throw e;
  }

  for (const field of requiredFields) {
    if (!(field in parsed)) {
      const e = new Error(`Required field "${field}" missing from LLM response`);
      e.name  = 'InvalidResponseError';
      throw e;
    }
  }
}

// Shared retry/backoff core for both call shapes below: runs attemptFn() up to
// MAX_ATTEMPTS times with exponential backoff between attempts, and throws
// CircuitOpenError on exhaustion. Tuning MAX_ATTEMPTS, the backoff curve, or
// classifyError now only needs to happen here, instead of being mirrored across the
// streaming (runLLMCall) and structured-output (runStructuredLLMCall) paths.
async function _withRetry(attemptFn) {
  let lastErr, lastReason;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      lastErr    = err;
      lastReason = classifyError(err);
      console.warn(
        `[CircuitBreaker] attempt ${attempt}/${MAX_ATTEMPTS} failed` +
        ` — ${lastReason}: ${err.message}`
      );
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  const openErr     = new Error(`LLM circuit open after ${MAX_ATTEMPTS} attempts (${lastReason})`);
  openErr.name      = 'CircuitOpenError';
  openErr.reason    = lastReason;
  openErr.lastError = lastErr;
  throw openErr;
}

// Same timeout/retry/backoff policy as runLLMCall, adapted for a plain Promise-returning
// call instead of a raw OpenAI stream — this is what LangChain's `withStructuredOutput()`
// calls use (KubePilot v5 graph nodes): structured-output parsing/validation already
// happens inside LangChain via the zod schema, so there's no raw-JSON `validateRaw()` step
// here, just timeout + retry + backoff around the same MAX_ATTEMPTS/REASON policy.
async function runStructuredLLMCall(invokeFn, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!FALLBACK_ENABLED) return invokeFn();
  return _withRetry(() => _raceTimeout(invokeFn(), timeoutMs));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a streaming LLM call with timeout, exponential-backoff retry, and JSON
 * schema validation.
 *
 * @param {() => Promise<AsyncIterable>} createStreamFn
 *   Zero-argument factory that creates a new streaming completion. Called fresh
 *   on each retry attempt so the stream is not replayed.
 *
 * @param {object}   opts
 * @param {string[]} opts.requiredFields
 *   Top-level JSON fields the response must contain.  A missing field causes a
 *   retry (classified as INVALID_RESPONSE).
 * @param {number}   opts.timeoutMs
 *   Per-attempt wall-clock limit.  Defaults to LLM_TIMEOUT_MS env var (30 s).
 *
 * @returns {Promise<{ raw: string, usage: object|null }>}
 *
 * @throws {CircuitOpenError}
 *   Only when FALLBACK_ENABLED=true and all MAX_ATTEMPTS are exhausted.
 *   Error carries `.reason` (one of REASON.*) and `.lastError`.
 *   When FALLBACK_ENABLED=false the last underlying error is rethrown unchanged.
 */
async function runLLMCall(createStreamFn, { requiredFields = [], timeoutMs = TIMEOUT_MS } = {}) {
  // ── Disabled mode: transparent passthrough, identical to pre-circuit-breaker ─
  if (!FALLBACK_ENABLED) {
    const stream = await createStreamFn();
    let raw = '', usage = null;
    for await (const chunk of stream) {
      raw   += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }
    return { raw, usage };
  }

  // ── Enabled mode: retry loop with timeout + backoff ───────────────────────
  return _withRetry(async () => {
    const { raw, usage } = await collectWithTimeout(createStreamFn, timeoutMs);
    if (requiredFields.length > 0) validateRaw(raw, requiredFields);
    return { raw, usage };
  });
}

module.exports = { runLLMCall, runStructuredLLMCall, REASON };
