'use strict';

const FALLBACK_ENABLED = process.env.FALLBACK_ENABLED === 'true';
const TIMEOUT_MS       = parseInt(process.env.LLM_TIMEOUT_MS ?? '30000', 10);
const MAX_ATTEMPTS     = 3;

const REASON = {
  TIMEOUT:          'llm_timeout',
  UNAVAILABLE:      'llm_unavailable',
  INVALID_RESPONSE: 'invalid_response',
};

// Wait for some milliseconds
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

// Race a promise against a timeout
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

// Collect a streaming response with a timeout
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

// Validate the JSON in a raw response
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

// Retry with exponential backoff
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

// Run a structured LLM call with retries
async function runStructuredLLMCall(invokeFn, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!FALLBACK_ENABLED) return invokeFn();
  return _withRetry(() => _raceTimeout(invokeFn(), timeoutMs));
}

// Run a streaming LLM call with retries
async function runLLMCall(createStreamFn, { requiredFields = [], timeoutMs = TIMEOUT_MS } = {}) {
  if (!FALLBACK_ENABLED) {
    const stream = await createStreamFn();
    let raw = '', usage = null;
    for await (const chunk of stream) {
      raw   += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }
    return { raw, usage };
  }

  return _withRetry(async () => {
    const { raw, usage } = await collectWithTimeout(createStreamFn, timeoutMs);
    if (requiredFields.length > 0) validateRaw(raw, requiredFields);
    return { raw, usage };
  });
}

module.exports = { runLLMCall, runStructuredLLMCall, REASON };
