'use strict';
const { PrometheusClient } = require('./prometheusClient');

// Per-cluster Prometheus client cache — reused across requests so we don't re-probe on
// every call. Shared between the metrics routes and the capacity routes, which both
// need to query the same per-cluster Prometheus endpoints.
const _podClusterClients = new Map();

function getPodClient(name, url) {
  if (!_podClusterClients.has(name)) _podClusterClients.set(name, new PrometheusClient(url));
  return _podClusterClients.get(name);
}

module.exports = { getPodClient };
