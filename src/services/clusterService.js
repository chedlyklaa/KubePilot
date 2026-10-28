'use strict';
const fs      = require('fs');
const yaml    = require('js-yaml');
const kubectl = require('../tools/kubectl');
const metricsCollector = require('../monitoring/metricsCollector');
const { ClusterCredential } = require('../db/models');

const GPU_RESOURCES = ['nvidia.com/gpu', 'amd.com/gpu', 'intel.com/gpu', 'gpu.intel.com/i915'];
const VALID_TIERS   = new Set(['dev', 'staging', 'production']);

// Format a byte count
function fmtBytes(b) {
  if (b == null || isNaN(b)) return null;
  if (b < 1024)      return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} Ki`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} Mi`;
  return                    `${(b / 1024 ** 3).toFixed(2)} Gi`;
}

function parseK8sQuantity(str) {
  if (!str) return null;
  const n = parseFloat(str);
  if (str.endsWith('Ki')) return n * 1024;
  if (str.endsWith('Mi')) return n * 1024 ** 2;
  if (str.endsWith('Gi')) return n * 1024 ** 3;
  if (str.endsWith('Ti')) return n * 1024 ** 4;
  if (str.endsWith('m'))  return n;
  if (str.endsWith('k'))  return n * 1000;
  return n;
}

// Parse kubectl top pods output
function parseTopOutput(raw, namespace) {
  const map = {};
  for (const line of (raw ?? '').split('\n').filter(Boolean)) {
    const [name, cpu, memory] = line.trim().split(/\s+/);
    if (name && cpu && memory)
      map[`${namespace}/${name}`] = {
        cpuRaw: cpu, memRaw: memory,
        cpuMilli: parseK8sQuantity(cpu), memBytes: parseK8sQuantity(memory),
      };
  }
  return map;
}

// Parse kubectl top pods output for all namespaces
function parseTopOutputAllNs(raw) {
  const map = {};
  for (const line of (raw ?? '').split('\n').filter(Boolean)) {
    const [ns, name, cpu, memory] = line.trim().split(/\s+/);
    if (ns && name && cpu && memory)
      map[`${ns}/${name}`] = {
        cpuRaw: cpu, memRaw: memory,
        cpuMilli: parseK8sQuantity(cpu), memBytes: parseK8sQuantity(memory),
      };
  }
  return map;
}

// Cluster data for the dashboard
class ClusterService {
  // Read the cluster config
  readConfig(configPath) {
    try {
      return yaml.load(fs.readFileSync(configPath, 'utf8')).clusters ?? [];
    } catch (err) {
      console.warn('[ClusterService] Failed to read clusters config:', err.message);
      return [];
    }
  }

  validateAndSaveConfig(configPath, clusters) {
    if (!Array.isArray(clusters))
      throw Object.assign(new Error('clusters must be an array'), { status: 400 });

    for (const c of clusters) {
      if (!c.name?.trim() || !c.context?.trim())
        throw Object.assign(new Error('each cluster requires name and context'), { status: 400 });
      if (!VALID_TIERS.has(c.tier ?? 'dev'))
        throw Object.assign(new Error(`invalid tier: ${c.tier}`), { status: 400 });
    }

    const content = yaml.dump({
      clusters: clusters.map(c => ({
        name:       c.name.trim(),
        context:    c.context.trim(),
        tier:       c.tier ?? 'dev',
        namespaces: ['*'],
      })),
    });
    fs.writeFileSync(configPath, content, 'utf8');
  }

  // List kubectl contexts
  async getContexts(configPath) {
    const namesRaw = await kubectl.runCommand('kubectl config get-contexts -o name');
    const names    = namesRaw.split('\n').map(s => s.trim()).filter(Boolean);

    let currentCtx = '';
    try { currentCtx = (await kubectl.runCommand('kubectl config current-context')).trim(); } catch {}

    const monitored    = this.readConfig(configPath);
    const monitoredMap = Object.fromEntries(monitored.map(c => [c.context, c]));

    const detected = names.map(n => ({
      name:             n,
      isCurrent:        n === currentCtx,
      isMonitored:      !!monitoredMap[n],
      config:           monitoredMap[n] ?? null,
      credentialBacked: false,
    }));

    const detectedNames = new Set(detected.map(d => d.name));
    let uploaded = [];
    try {
      const creds = await ClusterCredential.find().select('context').lean();
      uploaded = creds
        .filter(c => !detectedNames.has(c.context))
        .map(c => ({
          name:             c.context,
          isCurrent:        false,
          isMonitored:      !!monitoredMap[c.context],
          config:           monitoredMap[c.context] ?? null,
          credentialBacked: true,
        }));
    } catch (err) {
      console.warn('[ClusterService] Failed to load uploaded credentials:', err.message);
    }

    return [...detected, ...uploaded];
  }

  // Fetch pod health for one cluster
  async _fetchClusterPods(cluster, prometheusMap) {
    const { name, context: ctx, tier = 'dev', namespaces: ns = ['default'] } = cluster;
    const rawPods    = [];
    const metricsMap = {};
    const allNs      = ns.includes('*');
    let podsFetchOk  = false;
    let lastPodsErr  = null;

    if (allNs) {
      await Promise.allSettled([
        (async () => {
          try { rawPods.push(...((await kubectl.getPods('*', ctx, true)).items ?? [])); podsFetchOk = true; }
          catch (err) { lastPodsErr = err; console.warn(`[HEALTH] ${name}/all-namespaces pods: ${err.message}`); }
        })(),
        (async () => {
          try { Object.assign(metricsMap, parseTopOutputAllNs(
            await kubectl.runCommand(`kubectl --context=${ctx} top pods --all-namespaces --no-headers`)
          )); } catch { }
        })(),
      ]);
    } else {
      await Promise.allSettled(ns.map(async namespace => {
        try { rawPods.push(...((await kubectl.getPods(namespace, ctx, true)).items ?? [])); podsFetchOk = true; }
        catch (err) { lastPodsErr = err; console.warn(`[HEALTH] ${name}/${namespace} pods: ${err.message}`); }
        try { Object.assign(metricsMap, parseTopOutput(
          await kubectl.runCommand(`kubectl --context=${ctx} top pods -n ${namespace} --no-headers`),
          namespace
        )); } catch { }
      }));
    }

    if (!podsFetchOk) throw lastPodsErr ?? new Error('Failed to connect');

    const pods = this._shapePods(rawPods, metricsMap, prometheusMap);
    return { name, context: ctx, tier, connected: true, podCount: pods.length, pods };
  }

  // Shape pods for the UI
  _shapePods(rawPods, metricsMap, prometheusMap) {
    return rawPods.map(pod => {
      const meta   = pod.metadata  ?? {};
      const spec   = pod.spec      ?? {};
      const status = pod.status    ?? {};
      const csArr  = status.containerStatuses ?? [];
      const icArr  = status.initContainerStatuses ?? [];

      const readyCount = csArr.filter(c => c.ready).length;
      const restarts   = [...csArr, ...icArr].reduce((s, c) => s + (c.restartCount ?? 0), 0);
      const readyCond  = (status.conditions ?? []).find(c => c.type === 'Ready');

      const containers = (spec.containers ?? []).map(c => {
        const lim = c.resources?.limits   ?? {};
        const req = c.resources?.requests ?? {};
        const cs  = csArr.find(x => x.name === c.name) ?? {};
        const gpu = GPU_RESOURCES.reduce((v, k) => v ?? lim[k] ?? req[k] ?? null, null);
        return {
          name:          c.name,
          image:         c.image,
          ready:         cs.ready         ?? false,
          state:         Object.keys(cs.state ?? { waiting: true })[0],
          reason:        cs.state?.waiting?.reason ?? cs.state?.terminated?.reason ?? null,
          restartCount:  cs.restartCount  ?? 0,
          memLimitBytes: parseK8sQuantity(lim.memory ?? null),
          memReqBytes:   parseK8sQuantity(req.memory ?? null),
          cpuLimitMilli: parseK8sQuantity(lim.cpu    ?? null),
          cpuReqMilli:   parseK8sQuantity(req.cpu    ?? null),
          gpuRequested:  gpu ? parseInt(gpu, 10) : 0,
        };
      });

      const key        = `${meta.namespace}/${meta.name}`;
      const topMetrics = metricsMap[key]    ?? null;
      const promMetrics = prometheusMap[key] ?? null;

      const cpuRaw   = topMetrics?.cpuRaw   ?? (promMetrics?.cpuCores != null ? `${(promMetrics.cpuCores * 100).toFixed(1)}%` : null);
      const memRaw   = topMetrics?.memRaw   ?? (promMetrics?.memBytes != null ? fmtBytes(promMetrics.memBytes) : null);
      const cpuMilli = topMetrics?.cpuMilli ?? (promMetrics?.cpuCores != null ? promMetrics.cpuCores * 1000 : null);
      const memBytes = topMetrics?.memBytes ?? promMetrics?.memBytes ?? null;

      return {
        name:               meta.name,
        namespace:          meta.namespace ?? 'default',
        phase:              status.phase   ?? 'Unknown',
        ready:              `${readyCount}/${csArr.length}`,
        isReady:            readyCond?.status === 'True',
        restarts,
        node:               spec.nodeName ?? '—',
        startTime:          status.startTime ?? null,
        containers,
        cpuRaw, cpuMilli, memRaw, memBytes,
        hasMetrics:         !!(topMetrics || promMetrics),
        metricsSource:      topMetrics ? 'kubectl' : promMetrics ? 'prometheus' : null,
        totalMemLimitBytes: containers.reduce((s, c) => s != null && c.memLimitBytes != null ? s + c.memLimitBytes : null, 0) || null,
        totalGpu:           containers.reduce((s, c) => s + c.gpuRequested, 0),
      };
    });
  }

  async _getPrometheusMap() {
    if (!metricsCollector.isAvailable()) return {};
    try { return await metricsCollector.collectAllPodsMetrics() ?? {}; } catch { return {}; }
  }

  async getPodHealth(configPath) {
    const clusters      = this.readConfig(configPath);
    const prometheusMap = await this._getPrometheusMap();

    const results = await Promise.allSettled(
      clusters.map(cluster => this._fetchClusterPods(cluster, prometheusMap))
    );

    return {
      clusters: results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : {
          name:      clusters[i].name,
          context:   clusters[i].context,
          tier:      clusters[i].tier ?? 'dev',
          connected: false,
          podCount:  0,
          pods:      [],
          error:     r.reason?.message ?? 'Failed to connect',
        }
      ),
      timestamp: new Date().toISOString(),
    };
  }

  // Stream the namespaces of each cluster
  async streamClusterNamespaces(configPath, onCluster) {
    const clusters = this.readConfig(configPath);

    await Promise.allSettled(clusters.map(async cluster => {
      try {
        const namespaces = await kubectl.getNamespaces(cluster.context);
        onCluster({
          name: cluster.name, context: cluster.context, tier: cluster.tier ?? 'dev',
          connected: true, namespaces,
        });
      } catch (err) {
        onCluster({
          name: cluster.name, context: cluster.context, tier: cluster.tier ?? 'dev',
          connected: false, namespaces: [], error: err?.message ?? 'Failed to connect',
        });
      }
    }));
  }

  async getNamespacePods(configPath, clusterName, namespace) {
    const cluster = this.readConfig(configPath).find(c => c.name === clusterName);
    if (!cluster) throw Object.assign(new Error('Cluster not found or not monitored'), { status: 404 });

    const { context: ctx, tier = 'dev' } = cluster;
    const rawPods    = [];
    const metricsMap = {};
    let podsFetchOk  = false;
    let lastPodsErr  = null;

    await Promise.allSettled([
      (async () => {
        try { rawPods.push(...((await kubectl.getPods(namespace, ctx, true)).items ?? [])); podsFetchOk = true; }
        catch (err) { lastPodsErr = err; }
      })(),
      (async () => {
        try { Object.assign(metricsMap, parseTopOutput(
          await kubectl.runCommand(`kubectl --context=${ctx} top pods -n ${namespace} --no-headers`), namespace
        )); } catch { }
      })(),
    ]);

    if (!podsFetchOk) throw lastPodsErr ?? new Error('Failed to connect');

    const prometheusMap = await this._getPrometheusMap();
    const pods = this._shapePods(rawPods, metricsMap, prometheusMap);

    return { cluster: clusterName, namespace, tier, podCount: pods.length, pods };
  }
}

module.exports = new ClusterService();
