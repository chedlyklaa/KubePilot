#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });
const OpenAI = require('openai');

const message = process.argv.slice(2).join(' ') || 'hello who are you';

const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
if (!OPENAI_API_KEY || !OPENAI_MODEL) {
  console.error('[test-llm] Missing OPENAI_API_KEY and/or OPENAI_MODEL in .env — nothing to test.');
  process.exit(1);
}

console.log('[test-llm] Config:');
console.log(`  OPENAI_BASE_URL = ${OPENAI_BASE_URL || '(default: https://api.openai.com/v1)'}`);
console.log(`  OPENAI_MODEL    = ${OPENAI_MODEL}`);
console.log(`  OPENAI_API_KEY  = ${OPENAI_API_KEY.slice(0, 4)}...${OPENAI_API_KEY.slice(-4)} (${OPENAI_API_KEY.length} chars)`);
console.log(`  message         = "${message}"\n`);

const client = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });

async function main() {
  const t0 = Date.now();
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: message }],
  });
  console.log(`[test-llm] OK (${Date.now() - t0}ms)\n`);
  console.log(completion.choices[0]?.message?.content ?? '(empty response)');
}

main().catch(err => {
  console.error('[test-llm] FAILED');
  console.error('  status :', err?.status ?? '(none)');
  console.error('  message:', err.message);
  console.error('  body   :', err?.error ?? err?.response?.data ?? '(none)');
  process.exit(1);
});
