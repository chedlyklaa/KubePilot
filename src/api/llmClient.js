require('dotenv').config({ override: true });
const OpenAI = require('openai');

module.exports = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
