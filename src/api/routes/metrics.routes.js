'use strict';
const express = require('express');
const kubectl = require('../../tools/kubectl');
const tokenStore = require('../tokenStore');
const metricsCollector = require('../../monitoring/metricsCollector');
const { getPodClient } = require('../../monitoring/podClientCache');
const NodeAnalyzer = require('../../agents/nodeAnalyzer');
const EventAnalyzer = require('../../agents/eventAnalyzer');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// ── Token usage ───────────────────────────────────────────────────────────
router.get('/api/tokens', requireAuth, (_req, res) => res.json(tokenStore.getAll()));
router.post('/api/tokens/reset', requireAuth, requireAdmin, (_req, res) => {
  tokenStore.reset();
  res.json({ ok: true });
});

// ── Prometheus metrics endpoints ──────────────────────────────────────────
router.get('/api/metrics/status', requireAuth, (_req, res) => {
  res.json({
    available: metricsCollector.isAvailable(),
    url:       process.env.PROMETHEUS_URL || 'http://localhost:9090',
  });
});

router.get('/api/metrics/errors', requireAuth, asyncHandler(async (_req, res) => {
  const errors = await metricsCollector.getErrors();
  res.json({ errors, prometheusAvailable: metricsCollector.isAvailable() });
}));

// GET /api/metrics/pods — all-pods Prometheus metrics across all configured clusters
router.get('/api/metrics/pods', requireAuth, asyncHandler(async (_req, res) => {
  const clusterCfg = getClusters();
    const defaultUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090';

    // Build target list: one entry per unique Prometheus URL, using per-cluster prometheusUrl
    // if set, otherwise skipping (clusters without prometheusUrl won't appear here).
    // Fall back to the global default when no cluster has an explicit URL configured.
    const seenUrls = new Set();
    const targets  = [];
    for (const c of clusterCfg) {
      const url = c.prometheusUrl || null;
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      targets.push({ name: c.name, url });
    }
    if (targets.length === 0) targets.push({ name: 'default', url: defaultUrl });

    // Query each cluster's Prometheus in parallel
    const settled = await Promise.allSettled(targets.map(async ({ name, url }) => {
      const client = getPodClient(name, url);
      if (!client.available) await client.initialize();
      if (!client.available) return { cluster: name, pods: [] };

      const [cpuRes, memRes, restartRes, oomRes, highRestRes, throttleRes, imgRes] =
        await Promise.all([
          client.query('sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))'),
          client.query('sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})'),
          client.query('sum by (namespace, pod) (kube_pod_container_status_restarts_total)'),
          client.query('kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}'),
          client.query('sum by (namespace, pod) (kube_pod_container_status_restarts_total) > 3'),
          client.query(
            'sum by (namespace, pod) (rate(container_cpu_cfs_throttled_seconds_total{container!=""}[5m])) / ' +
            'sum by (namespace, pod) (rate(container_cpu_cfs_periods_total{container!=""}[5m])) > 0.25'
          ),
          client.query('kube_pod_container_status_waiting_reason{reason=~"ImagePullBackOff|ErrImagePull"}'),
        ]);

      const metricsMap = {};
      for (const r of (cpuRes ?? [])) {
        const k = `${r.metric.namespace}/${r.metric.pod}`;
        if (!metricsMap[k]) metricsMap[k] = {};
        metricsMap[k].cpuCores = parseFloat(r.value[1]);
      }
      for (const r of (memRes ?? [])) {
        const k = `${r.metric.namespace}/${r.metric.pod}`;
        if (!metricsMap[k]) metricsMap[k] = {};
        metricsMap[k].memBytes = parseFloat(r.value[1]);
      }
      for (const r of (restartRes ?? [])) {
        const k = `${r.metric.namespace}/${r.metric.pod}`;
        if (!metricsMap[k]) metricsMap[k] = {};
        metricsMap[k].restarts = Math.round(parseFloat(r.value[1]));
      }

      const oomSet      = new Set((oomRes      ?? []).map(r => `${r.metric.namespace}/${r.metric.pod}`));
      const highRestSet = new Set((highRestRes  ?? []).map(r => `${r.metric.namespace}/${r.metric.pod}`));
      const throttleSet = new Set((throttleRes  ?? []).map(r => `${r.metric.namespace}/${r.metric.pod}`));
      const imgSet      = new Set((imgRes       ?? []).map(r => `${r.metric.namespace}/${r.metric.pod}`));

      const errTypeMap = {};
      const registerErr = (key, type) => {
        if (!errTypeMap[key]) errTypeMap[key] = new Set();
        errTypeMap[key].add(type);
      };
      for (const k of oomSet)      registerErr(k, 'OOMKilled');
      for (const k of highRestSet) registerErr(k, 'HighRestarts');
      for (const k of throttleSet) registerErr(k, 'CPUThrottling');
      for (const k of imgSet)      registerErr(k, 'ImagePullFailed');

      // Union all keys so pods with errors always appear even without cAdvisor data
      const allKeys = new Set([
        ...Object.keys(metricsMap),
        ...Object.keys(errTypeMap),
      ]);

      const pods = [...allKeys].map(key => {
        const [namespace, pod] = key.split('/');
        const m = metricsMap[key] ?? {};
        return {
          key:        `${name}/${key}`,
          namespace,  pod,
          cluster:    name,
          cpuCores:   m.cpuCores ?? null,
          memBytes:   m.memBytes ?? null,
          restarts:   m.restarts ?? 0,
          oomKilled:  oomSet.has(key),
          errorTypes: errTypeMap[key] ? [...errTypeMap[key]] : [],
        };
      });

      return { cluster: name, pods };
    }));

    // Merge results from all clusters
    const allPods = settled
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value.pods);

    // Sort: pods with errors first, then by restarts desc
    allPods.sort((a, b) => {
      const ae = a.errorTypes.length > 0 ? 1 : 0;
      const be = b.errorTypes.length > 0 ? 1 : 0;
      if (be !== ae) return be - ae;
      return (b.restarts ?? 0) - (a.restarts ?? 0);
    });

  const available = allPods.length > 0 ||
    settled.some(r => r.status === 'fulfilled' && r.value.pods !== undefined);
  res.json({ available, pods: allPods });
}));

// GET /api/nodes — all nodes with status, conditions, Prometheus metrics
router.get('/api/nodes', requireAuth, asyncHandler(async (req, res) => {
  const clusters = getClusters();
    const allNodeMetrics = await metricsCollector.collectAllNodesMetrics().catch(() => null);

    const result = await Promise.all(clusters.map(async cluster => {
      try {
        const nodesJson  = await kubectl.getNodes(cluster.context);
        const nodeMap    = NodeAnalyzer.buildNodeMap(nodesJson);
        const nodeIssues = NodeAnalyzer.extractIssues(nodesJson, {}, allNodeMetrics ?? {});

        const nodes = (nodesJson.items ?? []).map(node => {
          const name       = node.metadata?.name;
          const labels     = node.metadata?.labels ?? {};
          const conds      = node.status?.conditions ?? [];
          const ready      = conds.find(c => c.type === 'Ready');
          const addrs      = node.status?.addresses ?? [];
          const internalIp = addrs.find(a => a.type === 'InternalIP')?.address;
          const hostname   = addrs.find(a => a.type === 'Hostname')?.address;
          // Prometheus node_exporter uses instance=IP:port; after stripping port the key is the IP.
          // Try exact node name first, then InternalIP, then Hostname as fallback.
          const m = allNodeMetrics?.[name]
                 ?? allNodeMetrics?.[internalIp]
                 ?? allNodeMetrics?.[hostname]
                 ?? null;
          const issues = nodeIssues.filter(i => i.nodeName === name);
          return {
            name,
            isReady:        ready?.status === 'True',
            isControlPlane: !!(labels['node-role.kubernetes.io/control-plane'] || labels['node-role.kubernetes.io/master']),
            conditions:     Object.fromEntries(conds.map(c => [c.type, c.status === 'True'])),
            allocatable:    node.status?.allocatable ?? {},
            cpuUsagePct:    m?.cpuUsagePct  ?? null,
            memUsedPct:     m?.memUsedPct   ?? null,
            diskUsedPct:    m?.diskUsedPct  ?? null,
            netRxBytesPerSec: m?.netRxBytesPerSec ?? null,
            netTxBytesPerSec: m?.netTxBytesPerSec ?? null,
            issues:         issues.map(i => ({ type: i.type, reason: i.reason })),
          };
        });

        return { clusterName: cluster.name, context: cluster.context, tier: cluster.tier ?? 'dev', nodes, connected: true };
      } catch (err) {
        return { clusterName: cluster.name, context: cluster.context, tier: cluster.tier ?? 'dev', nodes: [], connected: false, error: err.message };
      }
    }));

  res.json(result);
}));

// GET /api/events — recent warning events across all clusters
router.get('/api/events', requireAuth, asyncHandler(async (_req, res) => {
  const clusters = getClusters();
  const all = [];
  await Promise.all(clusters.map(async cluster => {
    try {
      const eventsJson = await kubectl.getEvents(cluster.context);
      const events     = EventAnalyzer.extractEvents(eventsJson);
      all.push(...events.map(e => ({ ...e, clusterName: cluster.name })));
    } catch { /* cluster unreachable */ }
  }));
  all.sort((a, b) => b.count - a.count);
  res.json({ events: all.slice(0, 200) });
}));

// GET /api/metrics/nodes — batch Prometheus node metrics
router.get('/api/metrics/nodes', requireAuth, asyncHandler(async (_req, res) => {
  if (!metricsCollector.isAvailable())
    return res.json({ available: false, nodes: {} });
  const nodeMetrics = await metricsCollector.collectAllNodesMetrics();
  res.json({ available: true, nodes: nodeMetrics ?? {} });
}));

module.exports = router;
