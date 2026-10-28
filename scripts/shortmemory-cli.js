#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { createClient } = require('redis');
const { loadConfig } = require('../src/config');

const ARGS    = process.argv.slice(2);
const CLEAR   = ARGS.includes('--clear');
const DRY_RUN = ARGS.includes('--dry-run');

async function scanAll(client, pattern) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

async function showStatus(client) {
  const queue  = await client.zRangeWithScores('sm:queue:fleet', 0, -1, { REV: true });
  const active = await client.sMembers('sm:active:fleet');

  console.log(`\n=== sm:active:fleet — ${active.length} workflow(s) currently in flight ===`);
  active.forEach(id => console.log(`  ${id}`));

  console.log(`\n=== sm:queue:fleet — ${queue.length} dispatch key(s) waiting ===`);
  queue.forEach(({ value, score }) => console.log(`  [priority ${score}] ${value}`));

  for (const [label, pattern] of [
    ['sm:incident:*', 'sm:incident:*'],
    ['sm:lock:*',     'sm:lock:*'],
    ['sm:cooldown:*', 'sm:cooldown:*'],
    ['sm:attempts:*', 'sm:attempts:*'],
    ['sm:group:*',    'sm:group:*'],
  ]) {
    const keys = await scanAll(client, pattern);
    console.log(`\n=== ${label} — ${keys.length} key(s) ===`);
  }
  console.log();
}

async function clearAll(client) {
  const keys = await scanAll(client, 'sm:*');
  console.log(`Found ${keys.length} sm:* key(s).`);
  if (DRY_RUN) {
    console.log('DRY RUN — nothing deleted. Re-run with --clear (no --dry-run) to actually delete them.');
    return;
  }
  if (keys.length === 0) {
    console.log('Nothing to delete.');
    return;
  }
  const CHUNK = 500;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += CHUNK) {
    deleted += await client.del(keys.slice(i, i + CHUNK));
  }
  console.log(`Deleted ${deleted} key(s). Short Memory is now empty.`);
}

async function main() {
  const { REDIS_URL } = loadConfig();
  const client = createClient({ url: REDIS_URL });
  client.on('error', err => console.error('[Redis] error:', err.message));
  await client.connect();

  if (CLEAR) await clearAll(client);
  else await showStatus(client);

  await client.quit();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
