'use strict';
const { createPubSub } = require('../api/pubsub');

const MAX_INCIDENTS = 300;
const FINISHED_RETENTION_MS = 30 * 60 * 1000;

const incidents = new Map();
const { notify, subscribe } = createPubSub();

function _evict() {
  if (incidents.size <= MAX_INCIDENTS) return;
  const byAge = [...incidents.values()].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  while (incidents.size > MAX_INCIDENTS && byAge.length) incidents.delete(byAge.shift().incidentKey);
}

// Record a decision event
function record(event) {
  try {
    if (!event?.workflow_id) return;
    const key = event.incident_id ?? `${event.resource?.kind ?? 'unknown'}/${event.resource?.namespace ?? ''}/${event.resource?.name ?? 'unknown'}`;

    let incident = incidents.get(key);
    if (!incident || incident.workflowId !== event.workflow_id) {
      incident = {
        incidentKey: key,
        workflowId:  event.workflow_id,
        resource:    event.resource ?? null,
        currentStep: null,
        startedAt:   event.ts,
        updatedAt:   event.ts,
        finishedAt:  null,
        outcome:     null,
        steps:       [],
      };
      incidents.set(key, incident);
      _evict();
    }

    incident.updatedAt = event.ts;
    if (event.resource) incident.resource = event.resource;
    incident.currentStep = event.component;

    const { ts, workflow_id, incident_id, component, duration_ms, resource, ...output } = event;
    incident.steps.push({ component, ts, durationMs: duration_ms ?? null, output });

    notify({ type: 'update', incident });
  } catch (err) {
    console.error('[LiveWorkflowStore] record() failed:', err.message);
  }
}

// Mark a workflow's incidents as finished
function finish(workflowId, outcome = null) {
  try {
    for (const incident of incidents.values()) {
      if (incident.workflowId !== workflowId || incident.finishedAt) continue;
      incident.finishedAt = new Date().toISOString();
      incident.outcome = outcome;
      incident.updatedAt = incident.finishedAt;
      notify({ type: 'update', incident });
    }
  } catch (err) {
    console.error('[LiveWorkflowStore] finish() failed:', err.message);
  }
}

function list() {
  return [...incidents.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

const _sweepTimer = setInterval(() => {
  const cutoff = Date.now() - FINISHED_RETENTION_MS;
  for (const [key, incident] of incidents) {
    if (incident.finishedAt && new Date(incident.finishedAt).getTime() < cutoff) incidents.delete(key);
  }
}, 60_000);
_sweepTimer.unref?.();

module.exports = { record, finish, list, subscribe };
