#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');

const OrchestratorAgent   = require('../src/agents/orchestratorAgent');
const { _toIssue }        = require('../src/orchestrator/graph');
const { generateFixture } = require('./generate-pod-fixtures');

const CLUSTER_NAME = 'synthetic-cluster';
const RESULTS_DIR  = path.join(__dirname, '../benchmark/results');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

const SEVERITY_COLOR = { critical: '#c0392b', high: '#e67e22', medium: '#d4ac0d', low: '#7f8c8d' };

// Run the test
async function main() {
  const fixture = generateFixture({
    namespaceCount:   args.namespaces   ? Number(args.namespaces)   : undefined,
    podsPerNamespace: args.perNamespace ? Number(args.perNamespace) : undefined,
    nodeCount:        args.nodes        ? Number(args.nodes)        : undefined,
    failureRate:      args.failureRate  ? Number(args.failureRate)  : undefined,
    nodeFailureRate:  args.nodeFailureRate ? Number(args.nodeFailureRate) : undefined,
    seed:             args.seed         ? Number(args.seed)         : undefined,
  });

  const signals = {
    pods:   OrchestratorAgent._summarizePods(fixture.pods),
    nodes:  OrchestratorAgent._summarizeNodes(fixture.nodes),
    events: OrchestratorAgent._summarizeEvents(fixture.events),
  };

  console.log(`Generated fixture (seed=${fixture.seed}): ${fixture.pods.items.length} pod(s) across ${new Set(fixture.manifest.map(m => m.namespace)).size} namespace(s), ${fixture.nodes.items.length} node(s)`);
  console.log(`-> ${signals.pods.length} pod(s) survived summarization (healthy pods are dropped before the LLM ever sees them)`);
  console.log(`Classifying with ${process.env.OPENAI_MODEL}...`);

  let incidents = [];
  try {
    incidents = await OrchestratorAgent._classify(signals, CLUSTER_NAME);
  } catch (err) {
    console.error(`Classification failed: ${err.message}`);
    process.exit(1);
  }

  const survivors = incidents.map(incident => ({
    incident,
    dispatchKey: OrchestratorAgent._dispatchKey(CLUSTER_NAME, incident),
  }));
  const priorities = OrchestratorAgent._computeGroupPriorities(survivors);

  const groups = new Map();
  for (const { incident, dispatchKey } of survivors) {
    if (!groups.has(dispatchKey)) groups.set(dispatchKey, []);
    groups.get(dispatchKey).push(incident);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: CLUSTER_NAME,
    seed: fixture.seed,
    input: {
      podCount:       fixture.pods.items.length,
      namespaceCount: new Set(fixture.manifest.map(m => m.namespace)).size,
      nodeCount:      fixture.nodes.items.length,
      manifest:       fixture.manifest,
    },
    signals,
    incidents,
    dispatchGroups: [...groups.entries()].map(([dispatchKey, groupIncidents]) => ({
      dispatchKey,
      priority: priorities.get(dispatchKey),
      incidentCount: groupIncidents.length,
      incidentTypes: groupIncidents.map(i => i.type),
      issuesSentToInvestigator: groupIncidents.map(_toIssue),
    })),
  };

  console.log(`-> ${incidents.length} incident(s) classified, ${groups.size} dispatch group(s)`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(RESULTS_DIR, `orchestrator-visualize-${stamp}.json`);
  const htmlPath = path.join(RESULTS_DIR, `orchestrator-visualize-${stamp}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, renderHtml(report));

  console.log(`\nWrote:\n  ${jsonPath}\n  ${htmlPath}`);
}

// Escape HTML
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(report) {
  const byNamespace = new Map();
  for (const m of report.input.manifest) {
    if (!byNamespace.has(m.namespace)) byNamespace.set(m.namespace, []);
    byNamespace.get(m.namespace).push(m);
  }

  const incidentsByKey = new Map();
  for (const inc of report.incidents) {
    const key = inc.namespace ?? inc.nodeName ?? '(unscoped)';
    if (!incidentsByKey.has(key)) incidentsByKey.set(key, []);
    incidentsByKey.get(key).push(inc);
  }

  const namespaceSections = [...byNamespace.entries()].map(([ns, pods]) => `
    <section class="ns-block">
      <h3>Namespace: <code>${esc(ns)}</code></h3>
      <table>
        <thead><tr><th>Pod</th><th>App</th><th>Generated as</th></tr></thead>
        <tbody>
          ${pods.map(p => `<tr><td>${esc(p.podName)}</td><td>${esc(p.appName)}</td><td>${esc(p.mode)}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>`).join('\n');

  const incidentRows = report.incidents.map(inc => `
    <tr>
      <td><span class="badge" style="background:${SEVERITY_COLOR[inc.severity] || '#555'}">${esc(inc.severity)}</span></td>
      <td>${esc(inc.type)}</td>
      <td>${esc(inc.scope)}</td>
      <td>${esc(inc.namespace ?? inc.nodeName ?? '—')}</td>
      <td>${esc(inc.podName ?? inc.deployment ?? '—')}</td>
      <td class="evidence">${esc(inc.evidenceSummary)}</td>
    </tr>`).join('');

  const groupRows = report.dispatchGroups.map(g => `
    <tr>
      <td><code>${esc(g.dispatchKey)}</code></td>
      <td>${g.priority}</td>
      <td>${g.incidentCount}</td>
      <td>${esc(g.incidentTypes.join(', '))}</td>
    </tr>`).join('');

  const investigatorPayloads = report.dispatchGroups.map(g => `
    <div class="payload-block">
      <h3>Group <code>${esc(g.dispatchKey)}</code> → <code>investigator.investigate(issues, clusterConfig)</code></h3>
      <pre>${esc(JSON.stringify(g.issuesSentToInvestigator, null, 2))}</pre>
    </div>`).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Orchestrator classify/dispatch report — ${esc(report.generatedAt)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
  h1, h2, h3 { color: #f0f6fc; }
  code { background: #161b22; padding: 0.1rem 0.35rem; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1.5rem; }
  th, td { border: 1px solid #30363d; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #161b22; }
  .evidence { max-width: 480px; }
  .badge { color: white; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
  .summary { display: flex; gap: 2rem; margin-bottom: 1.5rem; }
  .summary div { background: #161b22; padding: 0.75rem 1.25rem; border-radius: 8px; }
  .summary .n { font-size: 1.6rem; font-weight: 700; display: block; }
  .ns-block { margin-bottom: 1rem; }
  .payload-block { margin-bottom: 1.5rem; }
  pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.82rem; line-height: 1.4; }
</style>
</head>
<body>
  <h1>OrchestratorAgent classify + dispatch report</h1>
  <p>cluster=<code>${esc(report.cluster)}</code> seed=<code>${report.seed}</code> generated=${esc(report.generatedAt)}</p>

  <div class="summary">
    <div><span class="n">${report.input.podCount}</span>pods generated</div>
    <div><span class="n">${report.input.namespaceCount}</span>namespaces</div>
    <div><span class="n">${report.signals.pods.length}</span>reached the LLM</div>
    <div><span class="n">${report.incidents.length}</span>incidents classified</div>
    <div><span class="n">${report.dispatchGroups.length}</span>dispatch groups</div>
  </div>

  <h2>Incidents classified</h2>
  <table>
    <thead><tr><th>Severity</th><th>Type</th><th>Scope</th><th>Namespace/Node</th><th>Pod/Deployment</th><th>Evidence</th></tr></thead>
    <tbody>${incidentRows || '<tr><td colspan="6">No incidents classified.</td></tr>'}</tbody>
  </table>

  <h2>Dispatch groups</h2>
  <p>Each row is one workflow OrchestratorAgent would launch (namespace-grouped, or one per node) — see <code>_dispatchKey</code>/<code>_computeGroupPriorities</code> in orchestratorAgent.js.</p>
  <table>
    <thead><tr><th>Dispatch key</th><th>Priority</th><th>Incident count</th><th>Incident types</th></tr></thead>
    <tbody>${groupRows || '<tr><td colspan="4">Nothing would be dispatched.</td></tr>'}</tbody>
  </table>

  <h2>Payload sent to the Investigator</h2>
  <p>Per dispatch group, exactly what <code>runWorkflow()</code> builds and <code>investigatorNode</code> passes to <code>investigator.investigate(issues, clusterConfig)</code> (see graph.js's <code>_toIssue()</code>) — this is the last thing OrchestratorAgent produces before control leaves it.</p>
  ${investigatorPayloads}

  <h2>Generated input, by namespace</h2>
  <p>Ground truth — what was actually generated (including the intended failure mode), for comparing against what the LLM classified above.</p>
  ${namespaceSections}
</body>
</html>`;
}

main().catch(err => {
  console.error('[test-orchestrator-visualize] FAILED:', err.message);
  process.exit(1);
});
