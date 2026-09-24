#!/usr/bin/env node
// =============================================================================
// scripts/test-orchestrator-classify.js — exercise OrchestratorAgent's real
// classification + dispatch logic against canned cluster snapshots, with nothing
// actually dispatched.
//
// Runs each scenario in benchmark/scenarios/orchestrator-classify.yaml through the
// SAME functions production uses (orchestratorAgent.js's _summarizePods/
// _summarizeNodes/_summarizeEvents -> _classify() [real LLM call] -> _dispatchKey()/
// _computeGroupPriorities()), then prints what got classified and how it would be
// grouped for dispatch. No kubectl, no shortMemory, no runWorkflow — this only ever
// reads; it never enqueues or executes anything.
//
// Usage:
//   node scripts/test-orchestrator-classify.js                # run every scenario
//   node scripts/test-orchestrator-classify.js crashloop       # run scenarios whose
//                                                               # name matches (substring, case-insensitive)
//
// To test against a live cluster instead of fixtures, see the --live flag noted at
// the bottom of this file's usage output.
// =============================================================================
'use strict';

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const OrchestratorAgent = require('../src/agents/orchestratorAgent');

const SCENARIOS_PATH = path.join(__dirname, '../benchmark/scenarios/orchestrator-classify.yaml');
const CLUSTER_NAME    = 'test-cluster';

const filter = (process.argv[2] || '').toLowerCase();

function loadScenarios() {
  const doc = yaml.load(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const all = doc?.scenarios ?? [];
  return filter ? all.filter(s => s.name.toLowerCase().includes(filter)) : all;
}

function printIncident(inc, i) {
  console.log(`  [${i}] ${inc.type}  severity=${inc.severity}  scope=${inc.scope}`);
  const loc = inc.scope === 'node'
    ? `nodeName=${inc.nodeName}`
    : `namespace=${inc.namespace ?? '(none)'} pod=${inc.podName ?? '(none)'} deployment=${inc.deployment ?? '(none)'}`;
  console.log(`      ${loc}`);
  if (inc.oomKilled)                console.log(`      oomKilled=true exitCode=${inc.exitCode ?? '?'}`);
  if (inc.restartCount != null)     console.log(`      restartCount=${inc.restartCount}`);
  console.log(`      evidence: ${inc.evidenceSummary}`);
}

async function runScenario(scenario) {
  console.log('\n' + '='.repeat(78));
  console.log(scenario.name);
  if (scenario.expect) console.log(`expect: ${scenario.expect}`);
  console.log('='.repeat(78));

  const signals = {
    pods:   OrchestratorAgent._summarizePods({ items: scenario.pods ?? [] }),
    nodes:  OrchestratorAgent._summarizeNodes({ items: scenario.nodes ?? [] }),
    events: OrchestratorAgent._summarizeEvents({ items: scenario.events ?? [] }),
  };
  console.log(`signals sent to the LLM: ${signals.pods.length} pod(s), ${signals.nodes.length} node(s), ${signals.events.length} warning event(s)`);

  let incidents;
  try {
    incidents = await OrchestratorAgent._classify(signals, CLUSTER_NAME);
  } catch (err) {
    console.error(`  CLASSIFICATION FAILED: ${err.message}`);
    return;
  }

  if (incidents.length === 0) {
    console.log('\n  -> 0 incidents classified');
    return;
  }

  console.log(`\n  -> ${incidents.length} incident(s) classified:`);
  incidents.forEach((inc, i) => printIncident(inc, i));

  // Same grouping OrchestratorAgent._runCycle applies after the (skipped-here) cooldown
  // check — every incident in this harness is treated as a cooldown "survivor".
  const survivors = incidents.map(incident => ({
    incident,
    dispatchKey: OrchestratorAgent._dispatchKey(CLUSTER_NAME, incident),
  }));
  const priorities = OrchestratorAgent._computeGroupPriorities(survivors);

  const byKey = new Map();
  for (const { incident, dispatchKey } of survivors) {
    if (!byKey.has(dispatchKey)) byKey.set(dispatchKey, []);
    byKey.get(dispatchKey).push(incident.type);
  }

  console.log(`\n  -> ${byKey.size} dispatch group(s):`);
  for (const [dispatchKey, types] of byKey) {
    console.log(`      ${dispatchKey}  priority=${priorities.get(dispatchKey)}  incidents=[${types.join(', ')}]`);
  }
}

async function main() {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error(filter ? `No scenario name matches "${filter}"` : 'No scenarios found');
    process.exit(1);
  }
  console.log(`Running ${scenarios.length} scenario(s) against the real classifier (${process.env.OPENAI_MODEL})...`);
  for (const scenario of scenarios) {
    await runScenario(scenario);
  }
  console.log('\nDone. Nothing was dispatched — this only ran classification + dispatch-key logic.');
}

main().catch(err => {
  console.error('[test-orchestrator-classify] FAILED:', err.message);
  process.exit(1);
});
