require('dotenv').config({ override: true });
const OpenAI = require('openai');
const { loadConfig } = require('../config');

const config = loadConfig();

const key = config.OPENAI_API_KEY || '';
console.log(`[LLM] Using OPENAI_API_KEY: ${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars), baseURL: ${config.OPENAI_BASE_URL}`);

module.exports = new OpenAI({
  apiKey:  config.OPENAI_API_KEY,
  baseURL: config.OPENAI_BASE_URL,
});
