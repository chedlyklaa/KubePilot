#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });
const fs      = require('fs');
const path    = require('path');
const mongoose = require('mongoose');

const dbConnection      = require('../src/db/connection');
const kubectl           = require('../src/tools/kubectl');
const OrchestratorAgent = require('../src/agents/orchestratorAgent');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const CLUSTERS = args.clusters
  ? args.clusters.split(',').map(pair => {
      const [name, context] = pair.split(':');
      return { name, context: context || name };
    })
  : [{ name: args.cluster || args.context || 'minikube', context: args.context || 'minikube' }];
const NAMESPACES = args.namespaces ? args.namespaces.split(',') : ['*'];

async function _gatherAndTag(cluster) {
  console.log(`Fetching live state from "${cluster.name}" (context "${cluster.context}")...`);

  const [podsResult, nodesResult, eventsResult] = await Promise.allSettled([
    kubectl.getPods('*', cluster.context, true),
    kubectl.getNodes(cluster.context),
    kubectl.getEvents(cluster.context),
  ]);

  if (podsResult.status === 'rejected') {
    console.error(`[${cluster.name}] kubectl get pods failed: ${podsResult.reason?.message}`);
  }
  if (nodesResult.status === 'rejected')  console.warn(`[${cluster.name}] kubectl get nodes failed: ${nodesResult.reason?.message}`);
  if (eventsResult.status === 'rejected') console.warn(`[${cluster.name}] kubectl get events failed: ${eventsResult.reason?.message}`);

  const podsJson   = podsResult.status   === 'fulfilled' ? podsResult.value  : null;
  const nodesJson  = nodesResult.status  === 'fulfilled' ? nodesResult.value : null;
  const eventsJson = eventsResult.status === 'fulfilled' ? eventsResult.value : null;

  const filteredPods = NAMESPACES.includes('*') || !podsJson
    ? podsJson
    : { ...podsJson, items: (podsJson.items ?? []).filter(p => NAMESPACES.includes(p.metadata?.namespace)) };

  return {
    clusterName: cluster.name,
    pods:   OrchestratorAgent._summarizePods(filteredPods).map(p => ({ ...p, clusterName: cluster.name })),
    nodes:  OrchestratorAgent._summarizeNodes(nodesJson).map(n => ({ ...n, clusterName: cluster.name })),
    events: OrchestratorAgent._summarizeEvents(eventsJson).map(e => ({ ...e, clusterName: cluster.name })),
  };
}

async function main() {
  await dbConnection.connect();

  const perClusterSignals = await Promise.all(CLUSTERS.map(_gatherAndTag));

  const byNamespace = OrchestratorAgent._groupByNamespace(perClusterSignals);
  const allNodes = perClusterSignals.flatMap(cs => cs.nodes);

  const totalPods = [...byNamespace.values()].reduce((n, g) => n + g.pods.length, 0);
  console.log(`-> ${totalPods} pod(s) with issues across ${byNamespace.size} namespace(s), ${allNodes.length} node condition set(s), spanning ${CLUSTERS.length} cluster(s)`);

  console.log(`\nClassifying with ${process.env.OPENAI_MODEL}...`);

  const allIncidents = [];
  for (const [namespace, group] of byNamespace) {
    const signals = { pods: group.pods, nodes: [], events: group.events };
    console.log('\n' + '='.repeat(78));
    console.log(`ORCHESTRATOR INPUT — namespace "${namespace}" (${new Set(group.pods.map(p => p.clusterName)).size} cluster(s))`);
    console.log('='.repeat(78));
    console.log(JSON.stringify(signals, null, 2));

    const incidents = await OrchestratorAgent._classify(signals);
    allIncidents.push(...incidents);
  }
  if (allNodes.length > 0) {
    const signals = { pods: [], nodes: allNodes, events: [] };
    console.log('\n' + '='.repeat(78));
    console.log('ORCHESTRATOR INPUT — nodes (fleet-wide)');
    console.log('='.repeat(78));
    console.log(JSON.stringify(signals, null, 2));
    allIncidents.push(...await OrchestratorAgent._classify(signals));
  }

  const survivors = allIncidents.map(incident => ({
    incident,
    dispatchKey: OrchestratorAgent._dispatchKey(incident),
  }));
  const priorities = OrchestratorAgent._computeGroupPriorities(survivors);

  const groups = new Map();
  for (const { incident, dispatchKey } of survivors) {
    if (!groups.has(dispatchKey)) groups.set(dispatchKey, []);
    groups.get(dispatchKey).push(incident);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`ORCHESTRATOR OUTPUT — ${allIncidents.length} incident(s), ${groups.size} dispatch group(s)`);
  console.log('='.repeat(78));

  if (allIncidents.length === 0) {
    console.log('No incidents classified.');
  }

  allIncidents.forEach((inc, i) => {
    console.log(`\n[${i}] ${inc.type}  severity=${inc.severity}  scope=${inc.scope}  cluster=${inc.clusterName ?? '(none)'}`);
    const loc = inc.scope === 'node'
      ? `nodeName=${inc.nodeName}`
      : `namespace=${inc.namespace ?? '(none)'}  pod=${inc.podName ?? '(none)'}  deployment=${inc.deployment ?? '(none)'}`;
    console.log(`    ${loc}`);
    if (inc.oomKilled)            console.log(`    oomKilled=true exitCode=${inc.exitCode ?? '?'}`);
    if (inc.restartCount != null) console.log(`    restartCount=${inc.restartCount}`);
    console.log(`    evidence: ${inc.evidenceSummary}`);
  });

  console.log('\n' + '-'.repeat(78));
  console.log('Dispatch groups (one workflow each — a namespace group may now span clusters):');
  if (groups.size === 0) console.log('  (none)');
  for (const [dispatchKey, groupIncidents] of groups) {
    const clusters = [...new Set(groupIncidents.map(i => i.clusterName))];
    console.log(`  ${dispatchKey}  priority=${priorities.get(dispatchKey)}  clusters=[${clusters.join(', ')}]  incidents=[${groupIncidents.map(i => i.type).join(', ')}]`);
  }

  const resultsDir = path.join(__dirname, '../benchmark/results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp   = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `orchestrator-live-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    clusters: CLUSTERS,
    input: { perClusterSignals },
    output: {
      incidents: allIncidents,
      dispatchGroups: [...groups.entries()].map(([dispatchKey, gi]) => ({
        dispatchKey, priority: priorities.get(dispatchKey),
        clusters: [...new Set(gi.map(i => i.clusterName))],
        incidentTypes: gi.map(i => i.type),
      })),
    },
  }, null, 2));
  console.log(`\n(saved to ${outPath})`);
}

main()
  .catch(err => {
    console.error('[test-orchestrator-live] FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
