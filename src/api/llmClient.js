require('dotenv').config();
const OpenAI = require('openai');

module.exports = new OpenAI({
  apiKey:  "f8c180d8-e6e0-4863-a1b1-c6baef2bef70",
  baseURL: process.env.OPENAI_BASE_URL,
});
