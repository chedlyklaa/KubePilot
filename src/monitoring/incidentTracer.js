'use strict';
const fs   = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const liveWorkflowStore = require('./liveWorkflowStore');

const LOG_DIR = path.join(process.cwd(), 'logs');

function _traceErr(context, err) {
  try { console.error(`[IncidentTracer] ${context}: ${err?.message ?? err}`); } catch { }
}

// Get the resource an issue is about
function resourceFromIssue(issue) {
  if (!issue) return null;
  const clusterName = issue.clusterName ?? null;
  if (issue.podName)    return { kind: 'Pod',        namespace: issue.namespace ?? 'default', name: issue.podName,    clusterName };
  if (issue.deployment) return { kind: 'Deployment',  namespace: issue.namespace ?? 'default', name: issue.deployment, clusterName };
  if (issue.nodeName)   return { kind: 'Node',        namespace: null,                          name: issue.nodeName,   clusterName };
  return { kind: 'Cluster', namespace: issue.namespace ?? null, name: clusterName, clusterName };
}

class IncidentTracer {
  // Create a tracer for one incident
  constructor({ workflowId, incidentId = null, resource = null } = {}) {
    this.workflowId = workflowId ?? null;
    this.incidentId = incidentId;
    this.resource   = resource;
    this.events     = [];
    this._nodeStarts = {};
    this._createdAt  = Date.now();
    try {
      const cfg = loadConfig();
      this._enabled = cfg.TRACE_ENABLED;
      this._stdout  = cfg.TRACE_STDOUT;
    } catch (err) {
      this._enabled = false;
      this._stdout  = false;
      _traceErr('config load failed, tracing disabled', err);
    }
  }

  // Start timing a component
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

  // Record a component decision
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
