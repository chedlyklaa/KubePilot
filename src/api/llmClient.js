// override: true here only matters if this module is ever required standalone,
// before index.js's own dotenv call has run — in the app's real boot path, index.js
// already forces override:true and loadConfig() below returns its memoized result,
// so THIS call is a no-op by the time it runs (see index.js's comment for why the
// override has to happen at the very first load, not here).
require('dotenv').config({ override: true });
const OpenAI = require('openai');
const { loadConfig } = require('../config');

const config = loadConfig();

// Masked on purpose — never log the raw key (server logs/terminal scrollback aren't
// a safe place for a secret). This is enough to confirm which key is actually loaded
// (matches .env vs. some stale/leftover value) without exposing it.
const key = config.OPENAI_API_KEY || '';
console.log(`[LLM] Using OPENAI_API_KEY: ${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars), baseURL: ${config.OPENAI_BASE_URL}`);

// The one shared, admin-configured LLM client — credentials come only from validated
// server config, never from a request body (see chatService.js, which used to accept a
// per-request apiKey/baseURL override; that was unused by the dashboard and let a caller
// redirect conversation content, including injected cluster context, to an arbitrary
// endpoint).
module.exports = new OpenAI({
  apiKey:  config.OPENAI_API_KEY,
  baseURL: config.OPENAI_BASE_URL,
});
