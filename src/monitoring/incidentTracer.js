'use strict';
const fs   = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const liveWorkflowStore = require('./liveWorkflowStore');

// ── IncidentTracer ───────────────────────────────────────────────────────────────
// Developer-only, per-pod decision log. Answers "what did every component decide
// about this pod, and why" — completely separate from:
//   - WorkflowTracer (src/monitoring/workflowTracer.js): aggregated latency/LLM-call
//     counters for internal comparison work, not a per-decision log.
//   - issueTrackerStore (src/api/issueTrackerStore.js): the USER-FACING /issues page
//     timeline. This module must never write into it. Every step() call also feeds
//     liveWorkflowStore.js (in-memory only, admin-only /api/live-workflows) for the
//     dashboard's Live Pipeline debugging view — the file/stdout output below is a
//     separate, TRACE_ENABLED-gated concern, not the only consumer of this data anymore.
//
// Threaded through LangGraph exactly like WorkflowTracer already is — via
// config.configurable, NOT a WorkflowState/Annotation channel — so it can never leak
// into a prompt a node builds from raw state, and each concurrent workflow
// (orchestratorAgent.js dispatches several at once) gets its own instance.
//
// Never throws into the caller — every public method is wrapped so a bug in tracing
// (a bad JSON.stringify, a disk error) can't break a remediation workflow. Failures
// are reported to stderr only, never stdout/the trace file, so they can't be mistaken
// for a real trace event.

const LOG_DIR = path.join(process.cwd(), 'logs');

function _traceErr(context, err) {
  try { console.error(`[IncidentTracer] ${context}: ${err?.message ?? err}`); } catch { /* stderr itself failed — nothing more we can do */ }
}

// Derives the {kind, namespace, name} triple this event is about from an issue/incident
// object shaped like graph.js's _toIssue() output (or the raw incident it's built from —
// same field names either way, so this works for both orchestratorAgent.js's pre-_toIssue
// incidents and graph.js's post-_toIssue issues).
function resourceFromIssue(issue) {
  if (!issue) return null;
  const clusterName = issue.clusterName ?? null;
  if (issue.podName)    return { kind: 'Pod',        namespace: issue.namespace ?? 'default', name: issue.podName,    clusterName };
  if (issue.deployment) return { kind: 'Deployment',  namespace: issue.namespace ?? 'default', name: issue.deployment, clusterName };
  if (issue.nodeName)   return { kind: 'Node',        namespace: null,                          name: issue.nodeName,   clusterName };
  return { kind: 'Cluster', namespace: issue.namespace ?? null, name: clusterName, clusterName };
}

class IncidentTracer {
  // `resource` is the DEFAULT resource attached to a step() call that doesn't pass its
  // own `resources` override — set from whichever single issue is known at spawn time.
  // Group workflows (namespace-grouped dispatch) pass an explicit `resources` array per
  // call instead, so a namespace-wide decision still lands one filterable line per pod.
  constructor({ workflowId, incidentId = null, resource = null } = {}) {
    this.workflowId = workflowId ?? null;
    this.incidentId = incidentId;
    this.resource   = resource;
    this.events     = []; // in-memory append-only log for this run — mirrors what's on disk
    this._nodeStarts = {};
    this._createdAt  = Date.now(); // for reflector's mttr_seconds — spawn-to-resolution wall time
    try {
      const cfg = loadConfig();
      this._enabled = cfg.TRACE_ENABLED;
      this._stdout  = cfg.TRACE_STDOUT;
    } catch (err) {
      // loadConfig() throwing here would be a boot-time config error unrelated to
      // tracing — fail safe to "tracing off" rather than letting it propagate.
      this._enabled = false;
      this._stdout  = false;
      _traceErr('config load failed, tracing disabled', err);
    }
  }

  // Optional per-component timing helper — mirrors WorkflowTracer's startNode/endNode so
  // a node can bracket its own work without hand-computing Date.now() diffs everywhere.
  start(component) {
    try { this._nodeStarts[component] = Date.now(); } catch (err) { _traceErr('start() failed', err); }
  }

  elapsedSeconds() {
    return (Date.now() - this._createdAt) / 1000;
  }

  _elapsed(component) {
    const startedAt = this._nodeStarts[component];
    if (startedAt == null) return null;
    delete this._nodeStarts[component];
    return Date.now() - startedAt;
  }

  // Records one component's decision. `data` is component-specific free-form fields
  // (see graph.js call sites for the shape each component fills in).
  // `opts.resources`: explicit list of {kind, namespace, name, issueKey} to attribute this
  //   event to — used when one decision covers several pods (namespace-grouped dispatch).
  //   Falls back to this.resource when omitted.
  // `opts.durationMs`: explicit duration; falls back to start(component)'s elapsed time.
  step(component, data = {}, opts = {}) {
    try {
      const resources = opts.resources?.length ? opts.resources : [this.resource];
      const durationMs = opts.durationMs ?? this._elapsed(component);
      const ts = new Date().toISOString();

      for (const resource of resources) {
        const event = {
          ts,
          workflow_id: this.workflowId,
          incident_id: resource?.issueKey ?? this.incidentId,
          component,
          duration_ms: durationMs,
          resource: resource
            ? { kind: resource.kind, namespace: resource.namespace ?? null, name: resource.name ?? null, clusterName: resource.clusterName ?? null }
            : null,
          ...data,
        };
        // Always fed to the in-memory live dashboard view, regardless of TRACE_ENABLED
        // (that flag only gates the file/stdout output below) — see liveWorkflowStore.js.
        liveWorkflowStore.record(event);
        if (!this._enabled) continue;
        this.events.push(event);
        this._emit(event);
      }
    } catch (err) {
      _traceErr(`step("${component}") failed`, err);
    }
  }

  _emit(event) {
    let line;
    try {
      line = JSON.stringify(event);
    } catch (err) {
      _traceErr('failed to serialize trace event', err);
      return;
    }
    if (this._stdout) {
      try { console.log(line); } catch (err) { _traceErr('stdout write failed', err); }
    }
    if (!this.workflowId) return;
    fs.promises.mkdir(LOG_DIR, { recursive: true })
      .then(() => fs.promises.appendFile(path.join(LOG_DIR, `${this.workflowId}.jsonl`), line + '\n'))
      .catch(err => _traceErr('file append failed', err));
  }
}

module.exports = { IncidentTracer, resourceFromIssue, LOG_DIR };
