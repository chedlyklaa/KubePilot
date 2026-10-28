'use strict';
const { PrometheusClient } = require('./prometheusClient');

const _podClusterClients = new Map();

function getPodClient(name, url) {
  if (!_podClusterClients.has(name)) _podClusterClients.set(name, new PrometheusClient(url));
  return _podClusterClients.get(name);
}

module.exports = { getPodClient };
