'use strict';

const yaml = require('js-yaml');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

const AZURE_SKUS = [
  { name: 'Standard_B2s',    cpu: 2,  memGi: 4,   monthly: 38.54  },
  { name: 'Standard_D2s_v5', cpu: 2,  memGi: 8,   monthly: 70.08  },
  { name: 'Standard_D4s_v5', cpu: 4,  memGi: 16,  monthly: 140.16 },
  { name: 'Standard_D8s_v5', cpu: 8,  memGi: 32,  monthly: 280.32 },
  { name: 'Standard_D16s_v5',cpu: 16, memGi: 64,  monthly: 560.64 },
  { name: 'Standard_D32s_v5',cpu: 32, memGi: 128, monthly: 1121.28},
  { name: 'Standard_D48s_v5',cpu: 48, memGi: 192, monthly: 1681.92},
  { name: 'Standard_D64s_v5',cpu: 64, memGi: 256, monthly: 2242.56},
];

function matchAzureSku(cpuCores, memGi) {
  return AZURE_SKUS.find(s => s.cpu >= cpuCores && s.memGi >= memGi) ?? AZURE_SKUS[AZURE_SKUS.length - 1];
}

const AZURE_DISK_RATES = {
  'managed-csi':          0.075,
  'managed-csi-premium':  0.13,
  'managed-premium':      0.13,
  'azurefile':            0.06,
  'azurefile-csi':        0.06,
  'azurefile-premium':    0.12,
  'default':              0.04,
  'standard':             0.04,
};

const AZURE_LB_BASE_MONTHLY = 18.25;
const AZURE_LB_RULE_MONTHLY = 7.30;
const AZURE_LB_FREE_RULES   = 5;

const AZURE_EGRESS_BANDS = [
  { upToGi: 5,         rate: 0     },
  { upToGi: 10240,     rate: 0.087 },
  { upToGi: 51200,     rate: 0.083 },
  { upToGi: Infinity,  rate: 0.07  },
];

function calcEgressCost(monthlyGi) {
  let remaining = monthlyGi, cost = 0;
  for (const band of AZURE_EGRESS_BANDS) {
    const bandSize = band.upToGi - (monthlyGi - remaining);
    const used = Math.min(remaining, bandSize);
    cost += used * band.rate;
    remaining -= used;
    if (remaining <= 0) break;
  }
  return cost;
}

function parseStorageSize(str) {
  if (!str) return 0;
  const num = parseFloat(str);
  if (str.endsWith('Ti')) return num * 1024;
  if (str.endsWith('Gi')) return num;
  if (str.endsWith('Mi')) return num / 1024;
  if (str.endsWith('Ki')) return num / (1024 * 1024);
  return num / (1024 * 1024 * 1024);
}

async function getCapacityOverview(clusterName, { clusterService, kubectl, capacityForecastEngine, promClientGetter }) {
  let allClusters = [];
  try { allClusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
  const cluster = allClusters.find(c => c.name === clusterName);
  if (!cluster) return null;
  const ctx = cluster.context;

  const podHealth = await clusterService.getPodHealth(CONFIG_PATH);
  const clusterData = podHealth.clusters?.find(c => c.name === clusterName) ?? { pods: [] };
  const pods = clusterData.pods ?? [];

  let nodes = [];
  try {
    const nodesJson = await kubectl.getNodes(ctx);
    const topRaw = await kubectl.runCommand(`kubectl --context=${ctx} top nodes --no-headers`).catch(() => '');
    const topMap = {};
    for (const line of topRaw.split('\n').filter(Boolean)) {
      const [name, cpuRaw, cpuPct, memRaw, memPct] = line.trim().split(/\s+/);
      if (name) topMap[name] = { cpuRaw, cpuPct: parseInt(cpuPct) || 0, memRaw, memPct: parseInt(memPct) || 0 };
    }
    nodes = (nodesJson.items ?? []).map(n => {
      const alloc = n.status?.allocatable ?? {};
      const cpuCores = parseInt(alloc.cpu) || 0;
      const memStr = alloc.memory ?? '0';
      const memNum = parseFloat(memStr);
      const memBytes = memStr.includes('Ki') ? memNum * 1024
                     : memStr.includes('Mi') ? memNum * 1024 ** 2
                     : memStr.includes('Gi') ? memNum * 1024 ** 3
                     : memNum;
      const memGi = memBytes / (1024 ** 3);
      const top = topMap[n.metadata.name] ?? {};
      const ready = (n.status?.conditions ?? []).find(c => c.type === 'Ready');
      const sku = matchAzureSku(cpuCores, memGi);
      return {
        name: n.metadata.name, cpuCores, memGi: +memGi.toFixed(1),
        cpuPct: top.cpuPct ?? null, memPct: top.memPct ?? null,
        cpuUsed: top.cpuRaw ?? null, memUsed: top.memRaw ?? null,
        ready: ready?.status === 'True',
        azureSku: sku.name, azureMonthly: sku.monthly,
      };
    });
  } catch (err) { console.warn('[CAPACITY] nodes fetch:', err.message); }

  let forecast = null;
  try {
    const nodeMetrics = {};
    for (const n of nodes) {
      nodeMetrics[n.name] = { cpuUsagePct: n.cpuPct, memUsedPct: n.memPct, diskUsedPct: null };
    }
    const podMetrics = {};
    for (const p of pods) {
      if (p.cpuMilli != null || p.memBytes != null)
        podMetrics[`${p.namespace}/${p.name}`] = { cpuCores: (p.cpuMilli ?? 0) / 1000, memBytes: p.memBytes ?? 0 };
    }
    forecast = await capacityForecastEngine.liveSnapshotAndForecast(clusterName, nodeMetrics, podMetrics);
  } catch {}

  let totalReqCpuMilli = 0, totalReqMemBytes = 0;
  for (const p of pods) {
    for (const c of p.containers ?? []) {
      totalReqCpuMilli  += c.cpuReqMilli   ?? 0;
      totalReqMemBytes  += c.memReqBytes   ?? 0;
    }
  }
  const workloadCpuCores = Math.ceil(totalReqCpuMilli / 1000) || 1;
  const workloadMemGi    = Math.ceil(totalReqMemBytes / (1024 ** 3)) || 1;
  const workloadSku      = matchAzureSku(workloadCpuCores, workloadMemGi);

  const totalCpu   = nodes.reduce((s, n) => s + n.cpuCores, 0);
  const totalMemGi = nodes.reduce((s, n) => s + n.memGi, 0);
  const avgCpuPct  = nodes.length ? Math.round(nodes.reduce((s, n) => s + (n.cpuPct ?? 0), 0) / nodes.length) : 0;
  const avgMemPct  = nodes.length ? Math.round(nodes.reduce((s, n) => s + (n.memPct ?? 0), 0) / nodes.length) : 0;

  const running  = pods.filter(p => p.phase === 'Running' && p.isReady).length;
  const failing  = pods.filter(p => p.phase !== 'Running' || !p.isReady || p.restarts >= 5).length;

  const provisionedAzure = nodes.reduce((s, n) => s + n.azureMonthly, 0);

  let disks = [];
  let diskMonthly = 0;
  try {
    const pvs = await kubectl.getPersistentVolumes(ctx);
    disks = pvs.map(pv => {
      const sizeGi = parseStorageSize(pv.spec?.capacity?.storage ?? '0');
      const sc = pv.spec?.storageClassName ?? 'default';
      const rate = AZURE_DISK_RATES[sc] ?? AZURE_DISK_RATES.default;
      const monthly = +(sizeGi * rate).toFixed(2);
      const claim = pv.spec?.claimRef;
      return {
        name: pv.metadata.name,
        sizeGi: +sizeGi.toFixed(1),
        storageClass: sc,
        status: pv.status?.phase ?? 'Unknown',
        claim: claim ? `${claim.namespace}/${claim.name}` : null,
        ratePerGi: rate,
        monthly,
      };
    });
    diskMonthly = disks.reduce((s, d) => s + d.monthly, 0);
  } catch (err) { console.warn('[CAPACITY] disk cost:', err.message); }

  let loadBalancers = [];
  let lbMonthly = 0;
  try {
    const allSvcs = await kubectl.getServices('*', ctx);
    const lbs = (allSvcs ?? []).filter(s => s.spec?.type === 'LoadBalancer');
    loadBalancers = lbs.map(svc => {
      const ports = svc.spec?.ports?.length ?? 1;
      const extraRules = Math.max(0, ports - AZURE_LB_FREE_RULES);
      const monthly = +(AZURE_LB_BASE_MONTHLY + extraRules * AZURE_LB_RULE_MONTHLY).toFixed(2);
      const ips = (svc.status?.loadBalancer?.ingress ?? []).map(i => i.ip || i.hostname).filter(Boolean);
      return {
        name: `${svc.metadata.namespace}/${svc.metadata.name}`,
        ports,
        externalIPs: ips,
        monthly,
      };
    });
    lbMonthly = loadBalancers.reduce((s, l) => s + l.monthly, 0);
  } catch (err) { console.warn('[CAPACITY] lb cost:', err.message); }

  let egressMonthly = 0;
  let egressDetails = [];
  try {
    const promUrl = cluster.prometheusUrl || process.env.PROMETHEUS_URL;
    if (promUrl && promClientGetter) {
      const promClient = promClientGetter(clusterName, promUrl);
      if (!promClient.available) await promClient.initialize();
      if (promClient.available) {
        const result = await promClient.query(
          'sum by (instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*|cali.*|flannel.*|cni.*"}[5m]))'
        );
        if (result?.length) {
          let totalBytesPerSec = 0;
          egressDetails = result.map(r => {
            const bps = parseFloat(r.value?.[1] ?? 0);
            totalBytesPerSec += bps;
            const monthlyGi = (bps * 86400 * 30) / (1024 ** 3);
            return {
              instance: r.metric?.instance ?? 'unknown',
              bytesPerSec: +bps.toFixed(0),
              monthlyGi: +monthlyGi.toFixed(2),
            };
          });
          const totalMonthlyGi = (totalBytesPerSec * 86400 * 30) / (1024 ** 3);
          egressMonthly = +calcEgressCost(totalMonthlyGi).toFixed(2);
          for (const d of egressDetails) {
            d.monthly = +calcEgressCost(d.monthlyGi).toFixed(2);
          }
        }
      }
    }
  } catch (err) { console.warn('[CAPACITY] egress cost:', err.message); }

  const totalMonthly = +(provisionedAzure + diskMonthly + lbMonthly + egressMonthly).toFixed(2);

  return {
    cluster: clusterName,
    summary: {
      totalPods: pods.length, running, failing, totalNodes: nodes.length,
      totalCpu, totalMemGi, avgCpuPct, avgMemPct,
      azureMonthly:     +workloadSku.monthly.toFixed(2),
      azureSku:         workloadSku.name,
      workloadCpu:      workloadCpuCores,
      workloadMemGi,
      provisionedAzure: +provisionedAzure.toFixed(2),
      diskMonthly:      +diskMonthly.toFixed(2),
      lbMonthly:        +lbMonthly.toFixed(2),
      egressMonthly,
      totalMonthly,
    },
    nodes, pods, forecast,
    disks, loadBalancers, egressDetails,
  };
}

module.exports = {
  AZURE_SKUS,
  matchAzureSku,
  AZURE_DISK_RATES,
  calcEgressCost,
  parseStorageSize,
  getCapacityOverview,
};
