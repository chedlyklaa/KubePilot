require('dotenv').config({ override: true });
const OpenAI = require('openai');
const { loadConfig } = require('../config');

const config = loadConfig();

// The one shared, admin-configured LLM client — credentials come only from validated
// server config, never from a request body (see chatService.js, which used to accept a
// per-request apiKey/baseURL override; that was unused by the dashboard and let a caller
// redirect conversation content, including injected cluster context, to an arbitrary
// endpoint).
module.exports = new OpenAI({
  apiKey:  config.OPENAI_API_KEY,
  baseURL: config.OPENAI_BASE_URL,
});
