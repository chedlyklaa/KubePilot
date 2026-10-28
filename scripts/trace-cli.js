#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');

const COMPONENT_LABEL = {
  orchestrator: 'ORCHESTRATOR',
  investigator: 'INVESTIGATOR',
  planner:      'PLANNER',
  guardian:     'GUARDIAN',
  policy:       'POLICY',
  executor:     'EXECUTOR',
  reflector:    'REFLECTOR',
};

function readAllEvents(files) {
  const events = [];
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { }
    }
  }
  return events;
}

function listLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(LOG_DIR, f));
  } catch {
    return [];
  }
}

function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtLine(event) {
  const label = COMPONENT_LABEL[event.component] ?? event.component.toUpperCase();
  const dur   = fmtMs(event.duration_ms);
  switch (event.component) {
    case 'orchestrator':
      return `  ${label.padEnd(13)} classified=${event.classification} action=${event.action}${event.dedupResult ? ` dedup=${event.dedupResult}` : ''}  ${dur}`;
    case 'investigator': {
      const lines = [`  ${label.padEnd(13)} root=${event.root_cause_layer ?? '?'} confidence=${event.confidence ?? '?'}${event.escalated ? ' (escalated)' : ''}  ${dur}`];
      for (const sub of event.sub_events ?? []) {
        lines.push(`    └─ ${(sub.layer ?? '').padEnd(10)} ${(sub.status ?? '').toUpperCase().padEnd(8)} "${sub.issue ?? ''}"`);
      }
      return lines.join('\n');
    }
    case 'planner':
      return `  ${label.padEnd(13)} plan=${event.plan_summary} steps=${event.step_count} approval=${event.needs_approval ? 'yes' : 'no'} rollback=${event.has_rollback ? 'yes' : 'no'}  ${dur}`;
    case 'guardian':
      return `  ${label.padEnd(13)} ${event.verdict}  risk=${event.risk_tier}  "${event.rationale}"  ${dur}`;
    case 'policy':
      return `  ${label.padEnd(13)} ${event.status}${event.blockedRules?.length ? ` (${event.blockedRules.join('; ')})` : ''}  ${dur}`;
    case 'executor': {
      if (event.ready !== undefined) return `  ${label.padEnd(13)} ${event.summary}  ready=${event.ready}  ${dur}`;
      const why = event.reason || event.note;
      return `  ${label.padEnd(13)} ${event.action} ${event.status}${why ? ` — "${why}"` : ''}  ${dur}`;
    }
    case 'reflector':
      return `  ${label.padEnd(13)} outcome=${event.outcome} rca_accuracy=${event.rca_accuracy ?? '?'} mttr=${event.mttr_seconds != null ? `${event.mttr_seconds.toFixed(1)}s` : '?'}`;
    default:
      return `  ${label.padEnd(13)} ${JSON.stringify(event)}`;
  }
}

function renderWorkflow(workflowId, events) {
  const sorted = [...events].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = sorted[0];
  const resource = first?.resource;
  const orch = sorted.find(e => e.component === 'orchestrator');
  const header = resource
    ? `pod ${resource.namespace}/${resource.name}  ${orch?.classification?.[0] ?? ''}${orch ? ` (${(orch.severity ?? [])[0] ?? ''})` : ''}`
    : '';

  console.log(`\n[${workflowId}] ── ${header} ──`);
  for (const event of sorted) console.log(fmtLine(event));

  const startedAt = sorted[0] ? new Date(sorted[0].ts) : null;
  const reflector = sorted.filter(e => e.component === 'reflector').pop();
  if (startedAt && reflector) {
    const elapsed = reflector.mttr_seconds != null
      ? reflector.mttr_seconds.toFixed(0)
      : ((new Date(reflector.ts) - startedAt) / 1000).toFixed(0);
    console.log(`  ── ${reflector.outcome === 'fixed' ? 'resolved' : reflector.outcome} in ${elapsed}s ──`);
  }
}

function tracePod(podArg) {
  const [namespace, name] = podArg.split('/');
  if (!namespace || !name) {
    console.error('Usage: trace pod <namespace>/<name>');
    process.exit(1);
  }

  const events = readAllEvents(listLogFiles());
  const byWorkflow = new Map();
  for (const event of events) {
    if (event.resource?.namespace !== namespace || event.resource?.name !== name) continue;
    if (!byWorkflow.has(event.workflow_id)) byWorkflow.set(event.workflow_id, []);
    byWorkflow.get(event.workflow_id).push(event);
  }

  if (byWorkflow.size === 0) {
    console.log(`No traced incidents found for pod ${namespace}/${name} in ${LOG_DIR}`);
    return;
  }

  const workflowIds = [...byWorkflow.keys()].sort(
    (a, b) => new Date(byWorkflow.get(a)[0].ts) - new Date(byWorkflow.get(b)[0].ts)
  );
  for (const workflowId of workflowIds) renderWorkflow(workflowId, byWorkflow.get(workflowId));
}

function traceIncident(workflowId) {
  const file = path.join(LOG_DIR, `${workflowId}.jsonl`);
  const events = readAllEvents([file]);
  if (events.length === 0) {
    console.log(`No trace file found for workflow "${workflowId}" (expected ${file})`);
    return;
  }
  renderWorkflow(workflowId, events);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'pod' && arg) return tracePod(arg);
  if (cmd === 'incident' && arg) return traceIncident(arg);

  console.log(`Usage:
  node scripts/trace-cli.js pod <namespace>/<name>
  node scripts/trace-cli.js incident <workflowId>`);
  process.exit(1);
}

main();
