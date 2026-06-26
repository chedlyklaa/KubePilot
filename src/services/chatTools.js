'use strict';

const yaml   = require('js-yaml');
const fs     = require('fs');
const path   = require('path');
const kubectl         = require('../tools/kubectl');
const escalationStore = require('../api/escalationStore');
const { PrometheusClient } = require('../monitoring/prometheusClient');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

const _podClusterClients = new Map();
function _getPodClient(name, url) {
  if (!_podClusterClients.has(name)) _podClusterClients.set(name, new PrometheusClient(url));
  return _podClusterClients.get(name);
}

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_pod_logs',
      description: 'Fetch the last N lines of logs from a pod. Use when the user asks about errors, crashes, or what a pod is doing.',
      parameters: {
        type: 'object',
        properties: {
          pod:       { type: 'string', description: 'Pod name' },
          namespace: { type: 'string', description: 'Namespace (default: "default")' },
          cluster:   { type: 'string', description: 'Cluster name from the configured clusters' },
          tail:      { type: 'integer', description: 'Number of log lines (default: 80, max: 200)' },
          previous:  { type: 'boolean', description: 'If true, fetch logs from the previous container (before last restart)' },
        },
        required: ['pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_pod',
      description: 'Run kubectl describe on a pod. Returns events, conditions, container states, resource limits. Use for detailed pod diagnostics.',
      parameters: {
        type: 'object',
        properties: {
          pod:       { type: 'string', description: 'Pod name' },
          namespace: { type: 'string', description: 'Namespace (default: "default")' },
          cluster:   { type: 'string', description: 'Cluster name' },
        },
        required: ['pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pod_events',
      description: 'Fetch Kubernetes events for a specific pod. Shows scheduling, pulling, killing, OOM, backoff events.',
      parameters: {
        type: 'object',
        properties: {
          pod:       { type: 'string', description: 'Pod name' },
          namespace: { type: 'string', description: 'Namespace (default: "default")' },
          cluster:   { type: 'string', description: 'Cluster name' },
        },
        required: ['pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pods',
      description: 'List pods in a namespace with their status, restarts, and age. Use when the user asks about pod health or what is running.',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace ("*" for all namespaces, default: "default")' },
          cluster:   { type: 'string', description: 'Cluster name' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_node_status',
      description: 'Get node resource usage (CPU, memory) and conditions. Use when the user asks about node health or capacity.',
      parameters: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Cluster name' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_prometheus',
      description: 'Run a PromQL query against the cluster Prometheus. Use for metrics: CPU/memory trends, restart counts, OOM events, network usage.',
      parameters: {
        type: 'object',
        properties: {
          query:   { type: 'string', description: 'PromQL expression (e.g. rate(container_cpu_usage_seconds_total{pod="x"}[5m]))' },
          cluster: { type: 'string', description: 'Cluster name' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_escalations',
      description: 'Get current active escalations from KubePilot. Shows issues the agent could not fix automatically.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_deployments',
      description: 'List deployments in a namespace with replica counts and status. Use when the user asks about deployments, scaling, or rollouts.',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace ("*" for all, default: "default")' },
          cluster:   { type: 'string', description: 'Cluster name' },
        },
      },
    },
  },
];

function resolveContext(clusterName) {
  try {
    const clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
    if (clusterName) {
      const c = clusters.find(c => c.name === clusterName || c.context === clusterName);
      if (c) return c.context;
    }
    return clusters[0]?.context ?? 'minikube';
  } catch { return 'minikube'; }
}

async function execTool(name, args) {
  const ns  = args.namespace ?? 'default';
  const ctx = resolveContext(args.cluster);
  try {
    switch (name) {
      case 'get_pod_logs': {
        const tail = Math.min(args.tail ?? 80, 200);
        const prev = args.previous ? ' --previous' : '';
        return await kubectl.runCommand(`kubectl --context="${ctx}" logs ${args.pod} -n ${ns} --tail=${tail}${prev}`);
      }
      case 'describe_pod':
        return await kubectl.describePod(args.pod, ns, ctx);
      case 'get_pod_events':
        return await kubectl.runCommand(`kubectl --context="${ctx}" get events -n ${ns} --field-selector involvedObject.name=${args.pod} --sort-by=.lastTimestamp`);
      case 'get_node_status': {
        const top = await kubectl.runCommand(`kubectl --context="${ctx}" top nodes --no-headers`).catch(() => '');
        const nodes = await kubectl.runCommand(`kubectl --context="${ctx}" get nodes -o wide --no-headers`).catch(() => '');
        return `NODE RESOURCE USAGE:\n${top}\n\nNODE STATUS:\n${nodes}`;
      }
      case 'list_pods': {
        const nsFlag = ns === '*' ? '--all-namespaces' : `-n ${ns}`;
        return await kubectl.runCommand(`kubectl --context="${ctx}" get pods ${nsFlag} -o wide --no-headers`);
      }
      case 'query_prometheus': {
        const promUrl = process.env.PROMETHEUS_URL;
        if (!promUrl) return 'Prometheus is not configured (PROMETHEUS_URL not set)';
        const promClient = _getPodClient(args.cluster ?? '_default', promUrl);
        if (!promClient.available) await promClient.initialize();
        if (!promClient.available) return 'Prometheus is unreachable';
        const result = await promClient.query(args.query);
        if (!result?.length) return 'No data returned for this query';
        return result.map(r => {
          const labels = Object.entries(r.metric ?? {}).map(([k, v]) => `${k}="${v}"`).join(', ');
          const val = r.value?.[1] ?? '?';
          return `{${labels}} → ${val}`;
        }).join('\n');
      }
      case 'get_escalations': {
        const esc = escalationStore.getAll();
        if (!esc.length) return 'No active escalations';
        return esc.map(e =>
          `[${e.status}] ${e.issueKey} — ${e.issue?.type ?? '?'} in ${e.issue?.namespace ?? '?'} (attempts: ${e.attempts}, assigned: ${e.assignedTo?.name ?? 'unassigned'})`
        ).join('\n');
      }
      case 'get_deployments': {
        const nsFlag = ns === '*' ? '--all-namespaces' : `-n ${ns}`;
        return await kubectl.runCommand(`kubectl --context="${ctx}" get deployments ${nsFlag} -o wide --no-headers`);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

module.exports = { CHAT_TOOLS, execTool, resolveContext };
