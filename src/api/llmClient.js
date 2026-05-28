require('dotenv').config();
const OpenAI = require('openai');

module.exports = new OpenAI({
  apiKey:  "REDACTED",
  baseURL: process.env.OPENAI_BASE_URL,
});
