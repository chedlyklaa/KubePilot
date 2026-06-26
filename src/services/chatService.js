'use strict';

const yaml   = require('js-yaml');
const fs     = require('fs');
const path   = require('path');
const kubectl             = require('../tools/kubectl');
const escalationStore     = require('../api/escalationStore');
const approvalStore       = require('../api/approvalStore');
const metricsCollector    = require('../monitoring/metricsCollector');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

const CHAT_SYSTEM_PROMPT = `You are a senior Kubernetes SRE (Site Reliability Engineer) and Platform Engineer with deep, hands-on expertise in production cluster operations. You are embedded inside KubePilot — an autonomous Kubernetes management dashboard that monitors pod health, auto-remediates issues with LLM-driven agents, and routes unresolved problems to on-call engineers.

KUBERNETES EXPERTISE:
- Pod lifecycle, scheduler, kubelet, kube-proxy, etcd, API server internals
- Resource management: Requests/Limits, QoS classes (Guaranteed / Burstable / BestEffort), LimitRange, ResourceQuota
- Workload controllers: Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet
- Networking: CNI (Calico, Flannel, Cilium), Services (ClusterIP / NodePort / LoadBalancer / ExternalName), Ingress, Gateway API, NetworkPolicy
- Storage: PV, PVC, StorageClass, CSI drivers, ReadWriteOnce/ReadWriteMany access modes
- RBAC: Roles, ClusterRoles, ServiceAccounts, RoleBindings — principle of least privilege
- Operators and Custom Resource Definitions (CRDs)
- Autoscaling: HPA, VPA, KEDA, Cluster Autoscaler, Karpenter
- Pod disruption budgets, topology spread constraints, affinity/anti-affinity

DISTRIBUTIONS & CLOUD:
- Local: Minikube, k3s, kind, Rancher Desktop
- Managed: AWS EKS, Azure AKS, GCP GKE (including node pools, managed node groups, spot/preemptible)
- On-prem: kubeadm, RKE2, OpenShift

TOOLING:
- kubectl (advanced: jsonpath, custom-columns, --dry-run, diff, patch)
- Helm v3 (charts, hooks, library charts, values hierarchy)
- ArgoCD, Flux CD (GitOps workflows, sync policies, health checks)
- Prometheus, Grafana, AlertManager, Loki, Tempo (full observability stack)
- Kustomize, yq, kubectx/kubens
- Terraform, Pulumi (IaC for cluster and add-ons)
- Istio, Linkerd (service mesh: mTLS, traffic management, observability)
- Velero (backup and DR), External Secrets Operator, Sealed Secrets, HashiCorp Vault

DEVOPS & CI/CD:
- GitHub Actions, GitLab CI, Azure DevOps, Jenkins, Tekton
- Docker, containerd, BuildKit, multi-stage builds, image security scanning
- GitOps patterns, progressive delivery (Argo Rollouts, Flagger — canary, blue/green)
- SBOM, policy enforcement (OPA Gatekeeper, Kyverno)

RESPONSE RULES:
- Be concise but complete. Lead with the direct answer, add detail below.
- Always include working kubectl commands with proper flags (--context, -n, -o yaml).
- Use fenced code blocks for commands, YAML, and config snippets.
- Explain the root cause first, then the fix, then prevention.
- Mention relevant Kubernetes internals when they clarify WHY something fails.
- If a question is ambiguous, state your assumption before answering.
- Flag any destructive or irreversible operations with a ⚠ warning.
- Prefer safe, idempotent solutions (--dry-run=client, patch over replace).`;

const CLUSTER_SYSTEM_PROMPT = `You are KubePilot AI, embedded inside the KubePilot Kubernetes management dashboard. You have READ-ONLY access to the user's live Kubernetes clusters through tools.

RULES:
- Use the provided tools to fetch live data — do NOT guess or make up pod names, metrics, or statuses.
- Call tools proactively when the user asks about pods, logs, events, node health, metrics, or deployments.
- You can call multiple tools to gather evidence before responding.
- Reference specific pod names, namespaces, phases, restart counts from the tool results.
- You are read-only: diagnose and analyze only. For write operations, tell the user to use the Orders tab.
- Be concise. Lead with the key finding, then the explanation.
- When asked for a report or overview, call list_pods and get_node_status first to get current state.
- For Prometheus queries, use standard PromQL: container_memory_working_set_bytes, container_cpu_usage_seconds_total, kube_pod_container_status_restarts_total, etc.`;

const MAX_TOOL_ROUNDS = 5;

async function buildClusterContext(scopedClusters) {
  const lines = [`LIVE CLUSTER SNAPSHOT — ${new Date().toUTCString()}`];

  let clusters = scopedClusters ?? [];
  if (!clusters.length) {
    try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
  }

  for (const cluster of clusters) {
    const { name, context: ctx, tier = 'dev', namespaces: ns = ['default'] } = cluster;
    lines.push(`\nCLUSTER "${name}" tier=${tier} context=${ctx}`);

    try {
      const rawPods = [];
      if (ns.includes('*')) {
        const json = await kubectl.getPods('*', ctx, true);
        rawPods.push(...(json.items ?? []));
      } else {
        for (const namespace of ns) {
          try {
            const json = await kubectl.getPods(namespace, ctx, true);
            rawPods.push(...(json.items ?? []));
          } catch {}
        }
      }

      if (rawPods.length === 0) { lines.push('  (no pods found or cluster unreachable)'); continue; }

      let running = 0, failing = 0;
      for (const pod of rawPods) {
        const meta   = pod.metadata ?? {};
        const status = pod.status   ?? {};
        const spec   = pod.spec     ?? {};
        const csArr  = status.containerStatuses ?? [];
        const specContainers = spec.containers  ?? [];
        const restarts = csArr.reduce((s, c) => s + (c.restartCount ?? 0), 0);
        const readyN   = csArr.filter(c => c.ready).length;
        const reasons  = csArr
          .map(c => c.state?.waiting?.reason ?? c.state?.terminated?.reason)
          .filter(Boolean).join(',');

        const healthy = status.phase === 'Running' && readyN === csArr.length && restarts < 5;
        if (healthy) { running++; continue; }
        failing++;

        const resParts = specContainers.map(c => {
          const req = c.resources?.requests ?? {};
          const lim = c.resources?.limits   ?? {};
          const parts = [];
          if (req.memory || lim.memory) parts.push(`mem req=${req.memory ?? 'none'} lim=${lim.memory ?? 'none'}`);
          if (req.cpu    || lim.cpu)    parts.push(`cpu req=${req.cpu    ?? 'none'} lim=${lim.cpu    ?? 'none'}`);
          return parts.length ? `${c.name}(${parts.join(' ')})` : `${c.name}(no resources configured)`;
        }).join(' | ');

        lines.push(
          `  POD ${meta.namespace}/${meta.name} phase=${status.phase}` +
          ` ready=${readyN}/${csArr.length} restarts=${restarts}` +
          (reasons  ? ` reason=${reasons}`  : '') +
          (resParts ? ` resources=[${resParts}]` : '')
        );
      }
      lines.push(`  SUMMARY: ${running} healthy, ${failing} with issues, ${rawPods.length} total`);
    } catch (err) {
      lines.push(`  (cluster read error: ${err.message})`);
    }
  }

  const escs = escalationStore.getAll();
  lines.push(escs.length > 0 ? `\nACTIVE ESCALATIONS (${escs.length}):` : '\nACTIVE ESCALATIONS: none');
  for (const e of escs) {
    lines.push(
      `  ESC id=${e.id} key="${e.issueKey}" status=${e.status}` +
      ` attempts=${e.attempts} assigned=${e.assignedTo?.name ?? 'unassigned'}`
    );
  }

  const approvals = approvalStore.getPending();
  lines.push(approvals.length > 0 ? `\nPENDING APPROVALS (${approvals.length}):` : '\nPENDING APPROVALS: none');
  for (const a of approvals) {
    lines.push(
      `  APPROVAL id=${a.id} action=${a.payload?.action ?? '?'}` +
      ` key="${a.payload?.issueKey ?? '?'}" risk=${a.payload?.risk ?? '?'}`
    );
  }

  if (metricsCollector.isAvailable()) {
    try {
      const errors = await metricsCollector.getErrors();
      if (errors.length > 0) {
        lines.push(`\nPROMETHEUS ALERTS (${errors.length}):`);
        for (const e of errors) {
          lines.push(`  ALERT type=${e.type} severity=${e.severity} pod=${e.namespace}/${e.pod} count=${e.count}`);
        }
      } else {
        lines.push('\nPROMETHEUS ALERTS: none');
      }
    } catch {}
  }

  return lines.join('\n');
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

async function streamChat(req, res, { llm, chatTools }) {
  const { messages, apiKey, baseURL, model, withClusterContext } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array required' });

  const client = (apiKey || baseURL)
    ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
    : llm;

  const systemPrompt = withClusterContext ? CLUSTER_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;

  sseHeaders(res);
  const t0 = Date.now();
  const useTools = withClusterContext;
  const conversationMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const createParams = {
        model:       model || process.env.OPENAI_MODEL,
        temperature: 0.7,
        stream:      true,
        messages:    conversationMessages,
      };
      if (useTools && round < MAX_TOOL_ROUNDS) createParams.tools = chatTools.CHAT_TOOLS;

      const stream = await client.chat.completions.create(createParams);

      let toolCalls = [];
      let currentToolCall = null;
      let hasContent = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          hasContent = true;
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index != null && tc.id) {
              currentToolCall = { id: tc.id, name: tc.function?.name ?? '', args: '' };
              toolCalls[tc.index] = currentToolCall;
            }
            if (tc.function?.name && toolCalls[tc.index]) {
              toolCalls[tc.index].name = tc.function.name;
            }
            if (tc.function?.arguments && toolCalls[tc.index]) {
              toolCalls[tc.index].args += tc.function.arguments;
            }
          }
        }
      }

      toolCalls = toolCalls.filter(Boolean);

      if (toolCalls.length === 0) break;

      res.write(`data: ${JSON.stringify({ content: '\n\n*Fetching live data...*\n\n' })}\n\n`);

      conversationMessages.push({
        role: 'assistant',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      for (const tc of toolCalls) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.args || '{}'); } catch {}

        const result = await chatTools.execTool(tc.name, parsedArgs);
        const truncated = (result ?? '').slice(0, 4000);

        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncated,
        });
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, elapsed: Date.now() - t0 })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
}

async function chatNonStreaming(req, res, llm) {
  const { messages, apiKey, baseURL, model } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array required' });

  const client = (apiKey || baseURL)
    ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
    : llm;

  const t0 = Date.now();
  try {
    const stream = await client.chat.completions.create({
      model:       model || process.env.OPENAI_MODEL,
      temperature: 0.7,
      stream:      true,
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        ...messages,
      ],
    });
    let content = '';
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content ?? '';
    }
    res.json({ content, elapsed: Date.now() - t0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function generatePdfReport(req, res, llm) {
  const { messages, reportContent } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages required' });

  const sourceText = reportContent?.trim()
    ? reportContent.replace(/\[LIVE CLUSTER DATA\][\s\S]*?\[MY QUESTION\]\n?/i, '').slice(0, 6000)
    : messages.slice(-10)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.replace(/\[LIVE CLUSTER DATA\][\s\S]*?\[MY QUESTION\]\n?/i, '').slice(0, 900)}`)
        .join('\n\n');

  const userInstruction = reportContent?.trim()
    ? `Convert the following AI assistant response into the report schema. Do NOT add new findings, change conclusions, or invent information — only restructure and label what is already stated in the text.\n\n${sourceText}`
    : `Generate a structured report for this conversation:\n\n${sourceText}`;

  const REPORT_SYSTEM = `You are a professional Kubernetes SRE report generator inside KubePilot.
Produce a single structured JSON report. Output ONLY valid JSON — no markdown, no extra text.

Required schema:
{
  "title":    "concise descriptive report title",
  "summary":  "2–3 sentence executive summary of key findings",
  "severity": "ok | warn | critical",
  "sections": [
    { "heading": "...", "type": "text",         "content": "..." },
    { "heading": "...", "type": "list",         "items":   ["..."] },
    { "heading": "...", "type": "status_table", "rows": [
        { "label": "resource", "value": "detail", "status": "ok|warn|error", "note": "" }
      ]
    },
    { "heading": "...", "type": "findings",     "items": [
        { "severity": "critical|high|medium|low", "title": "...", "detail": "...", "action": "..." }
      ]
    }
  ],
  "recommendations": ["actionable recommendation 1", "..."]
}`;

  try {
    const completion = await llm.chat.completions.create({
      model:       process.env.OPENAI_MODEL,
      temperature: 0.1,
      stream:      false,
      messages: [
        { role: 'system', content: REPORT_SYSTEM },
        { role: 'user',   content: userInstruction },
      ],
    });
    const raw   = completion.choices[0]?.message?.content ?? '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'LLM returned unparseable report structure' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  CHAT_SYSTEM_PROMPT,
  CLUSTER_SYSTEM_PROMPT,
  buildClusterContext,
  streamChat,
  chatNonStreaming,
  generatePdfReport,
};
