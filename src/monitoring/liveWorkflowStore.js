'use strict';
const { createPubSub } = require('../api/pubsub');

// ── LiveWorkflowStore ────────────────────────────────────────────────────────────
// In-memory-only, current/recent view of "what is the pipeline doing right now" for
// the dashboard's Live Pipeline debugging page. Fed by IncidentTracer.step() (see
// src/monitoring/incidentTracer.js) — the exact same per-component decision events
// already computed at every graph.js node — so this adds no new computation, just an
// additional recording of data that already exists.
//
// Deliberately NOT persisted anywhere (no disk, no DB) and NOT gated by TRACE_ENABLED
// the way IncidentTracer's file/stdout output is: this must always be available so an
// operator can watch the pipeline work, exactly like issueTrackerStore is deliberately
// NOT the thing this reuses (that's the durable, user-facing lifecycle view backed by
// Mongo — this is a raw, ephemeral, developer-facing decision trail). Bounded by
// MAX_INCIDENTS + a periodic sweep of old finished entries so a long-lived server
// doesn't grow this map forever.

const MAX_INCIDENTS = 300;
const FINISHED_RETENTION_MS = 30 * 60 * 1000; // keep a finished incident visible for 30 min

const incidents = new Map(); // incidentKey -> record (see record() below for shape)
const { notify, subscribe } = createPubSub();

function _evict() {
  if (incidents.size <= MAX_INCIDENTS) return;
  const byAge = [...incidents.values()].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  while (incidents.size > MAX_INCIDENTS && byAge.length) incidents.delete(byAge.shift().incidentKey);
}

// Records one component's decision event — same event object IncidentTracer.step()
// already builds (ts, workflow_id, incident_id, component, duration_ms, resource,
// ...component-specific data). Never throws — a bug here must never affect the real
// remediation pipeline.
//
// A new workflow_id for an already-known incidentKey means a fresh investigation
// attempt (re-diagnose loop, or a brand-new cycle after cooldown) — that resets the
// step timeline rather than appending to a stale one, so the table always shows the
// CURRENT attempt, not a growing history across restarts.
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

    // Full record in the event (not just a key) — same upsert-by-id pattern as
    // issueTrackerStore's SSE feed — so the frontend never needs a separate per-row
    // detail fetch; the list response and every SSE update carry the whole thing.
    notify({ type: 'update', incident });
  } catch (err) {
    console.error('[LiveWorkflowStore] record() failed:', err.message);
  }
}

// Marks every incident currently attributed to `workflowId` as finished — called once
// per runWorkflow() completion (see graph.js). A workflow can cover several incidents
// (namespace-grouped dispatch), so this sweeps the whole map rather than taking a
// single key.
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

// Periodic sweep — drop finished incidents past the retention window. In-flight
// (unfinished) incidents are never swept here; MAX_INCIDENTS' LRU eviction in record()
// is the only bound on those.
const _sweepTimer = setInterval(() => {
  const cutoff = Date.now() - FINISHED_RETENTION_MS;
  for (const [key, incident] of incidents) {
    if (incident.finishedAt && new Date(incident.finishedAt).getTime() < cutoff) incidents.delete(key);
  }
}, 60_000);
_sweepTimer.unref?.();

module.exports = { record, finish, list, subscribe };
