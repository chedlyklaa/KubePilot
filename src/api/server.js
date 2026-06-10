const express             = require('express');
const cors                = require('cors');
const yaml                = require('js-yaml');
const fs                  = require('fs');
const path                = require('path');
const llm                 = require('./llmClient');
const kubectl             = require('../tools/kubectl');
const logStore            = require('./logStore');
const tokenStore          = require('./tokenStore');
const approvalStore       = require('./approvalStore');
const escalationStore     = require('./escalationStore');
const notificationStore   = require('./notificationStore');
const authService         = require('./authService');
const mongoose = require('mongoose');
const { User, ApprovalHistory, EscalationHistory, ChatHistory, CommandHistory } = require('../db/models');

const metricsCollector  = require('../monitoring/metricsCollector');

// ── Service layer ─────────────────────────────────────────────────────────────
const userService     = require('../services/userService');
const profileService  = require('../services/profileService');
const clusterService  = require('../services/clusterService');
const provisionService = require('../services/provisionService');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

// Format bytes to a human-readable string (used when converting Prometheus bytes to display labels)
function fmtBytesServer(b) {
  if (b == null || isNaN(b)) return null;
  if (b < 1024)        return `${b}B`;
  if (b < 1024 ** 2)   return `${(b / 1024).toFixed(0)}Ki`;
  if (b < 1024 ** 3)   return `${(b / 1024 ** 2).toFixed(0)}Mi`;
  return                      `${(b / 1024 ** 3).toFixed(2)}Gi`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '') || req.query.token || null;
}
function requireAuth(req, res, next) {
  const user = authService.getUser(getToken(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user; next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}
function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// Attach a heartbeat to an SSE response — prevents ECONNRESET on idle streams
function heartbeat(req, res) {
  const iv = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => clearInterval(iv));
}

// ── Build a live cluster context snapshot for the AI chat assistant ──────────
// Returns a compact text block injected into the system prompt when the user
// enables "Live Cluster" mode. Read-only: only kubectl get/describe, no writes.
async function buildClusterContext() {
  const lines = [`LIVE CLUSTER SNAPSHOT — ${new Date().toUTCString()}`];

  // ── Pods across all configured clusters ────────────────────────────────────
  let clusters = [];
  try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}

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
        const csArr  = status.containerStatuses ?? [];
        const restarts = csArr.reduce((s, c) => s + (c.restartCount ?? 0), 0);
        const readyN   = csArr.filter(c => c.ready).length;
        const reasons  = csArr
          .map(c => c.state?.waiting?.reason ?? c.state?.terminated?.reason)
          .filter(Boolean).join(',');

        const healthy = status.phase === 'Running' && readyN === csArr.length && restarts < 5;
        if (healthy) { running++; continue; }
        failing++;
        lines.push(
          `  POD ${meta.namespace}/${meta.name} phase=${status.phase}` +
          ` ready=${readyN}/${csArr.length} restarts=${restarts}` +
          (reasons ? ` reason=${reasons}` : '')
        );
      }
      lines.push(`  SUMMARY: ${running} healthy, ${failing} with issues, ${rawPods.length} total`);
    } catch (err) {
      lines.push(`  (cluster read error: ${err.message})`);
    }
  }

  // ── Active escalations ─────────────────────────────────────────────────────
  const escs = escalationStore.getAll();
  lines.push(escs.length > 0 ? `\nACTIVE ESCALATIONS (${escs.length}):` : '\nACTIVE ESCALATIONS: none');
  for (const e of escs) {
    lines.push(
      `  ESC id=${e.id} key="${e.issueKey}" status=${e.status}` +
      ` attempts=${e.attempts} assigned=${e.assignedTo?.name ?? 'unassigned'}`
    );
  }

  // ── Pending approvals ──────────────────────────────────────────────────────
  const approvals = approvalStore.getPending();
  lines.push(approvals.length > 0 ? `\nPENDING APPROVALS (${approvals.length}):` : '\nPENDING APPROVALS: none');
  for (const a of approvals) {
    lines.push(
      `  APPROVAL id=${a.id} action=${a.payload?.action ?? '?'}` +
      ` key="${a.payload?.issueKey ?? '?'}" risk=${a.payload?.risk ?? '?'}`
    );
  }

  // ── Prometheus alerts ──────────────────────────────────────────────────────
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

function createServer(port = 3001) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  // ── Auth ──────────────────────────────────────────────────────────────────
  app.post('/api/auth/login', async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password);
    if (!result) return res.status(401).json({ error: 'Invalid email or password' });
    res.json(result);
  });
  app.post('/api/auth/logout', requireAuth, (req, res) => {
    authService.logout(getToken(req)); res.json({ success: true });
  });
  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

  // ── Logs ──────────────────────────────────────────────────────────────────
  app.get('/api/logs', requireAuth, (_req, res) => res.json(logStore.getAll()));
  app.get('/api/logs/stream', requireAuth, (req, res) => {
    sseHeaders(res); heartbeat(req, res);
    logStore.getAll().forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const unsub = logStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', unsub);
  });

  // ── Approvals ─────────────────────────────────────────────────────────────
  app.get('/api/approvals', requireAuth, (_req, res) => res.json(approvalStore.getPending()));
  app.get('/api/approvals/stream', requireAuth, (req, res) => {
    sseHeaders(res); heartbeat(req, res);
    res.write(`data: ${JSON.stringify({ type: 'init', approvals: approvalStore.getPending() })}\n\n`);
    const unsub = approvalStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', unsub);
  });
  app.post('/api/approvals/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    res.json({ success: await approvalStore.approve(req.params.id, req.user) });
  });
  app.post('/api/approvals/:id/deny', requireAuth, requireAdmin, async (req, res) => {
    res.json({ success: await approvalStore.deny(req.params.id, req.user) });
  });

  // ── Escalations ───────────────────────────────────────────────────────────
  app.get('/api/escalations', requireAuth, (_req, res) => res.json(escalationStore.getAll()));
  app.get('/api/escalations/stream', requireAuth, (req, res) => {
    sseHeaders(res); heartbeat(req, res);
    res.write(`data: ${JSON.stringify({ type: 'init', escalations: escalationStore.getAll() })}\n\n`);
    const unsub = escalationStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', unsub);
  });

  // Acknowledge (claim ownership)
  app.post('/api/escalations/:id/acknowledge', requireAuth, async (req, res) => {
    res.json({ success: await escalationStore.acknowledge(req.params.id, req.user) });
  });

  // Update state (working | fixed | not_fixed | need_help)
  app.put('/api/escalations/:id/state', requireAuth, async (req, res) => {
    const valid = new Set(['in_progress', 'fixed', 'not_fixed', 'need_help']);
    if (!valid.has(req.body.state)) return res.status(400).json({ error: 'Invalid state' });
    res.json({ success: await escalationStore.updateState(req.params.id, req.body.state, req.user) });
  });

  // Assign to user (admin only)
  app.put('/api/escalations/:id/assign', requireAuth, requireAdmin, async (req, res) => {
    const target = await User.findById(req.body.userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const assignedTo = { userId: target._id.toString(), name: target.name, email: target.email, role: target.role };
    res.json({ success: await escalationStore.assign(req.params.id, assignedTo, req.user) });
  });

  // Request reassignment (developer)
  app.post('/api/escalations/:id/request-reassign', requireAuth, async (req, res) => {
    res.json({ success: await escalationStore.requestReassign(req.params.id, req.user) });
  });

  // Delete escalation (admin only)
  app.delete('/api/escalations/:id', requireAuth, requireAdmin, async (req, res) => {
    const success = await escalationStore.remove(req.params.id);
    if (!success) return res.status(404).json({ error: 'Escalation not found' });
    res.json({ success: true });
  });

  // Reassign a historical escalation record (admin only)
  app.put('/api/history/escalations/:id/assign', requireAuth, requireAdmin, async (req, res) => {
    const target = await User.findById(req.body.userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const assignedTo = { userId: target._id.toString(), name: target.name, email: target.email, role: target.role };
    const doc = await EscalationHistory.findByIdAndUpdate(
      req.params.id,
      { assignedTo, assignedAt: new Date(), assignedBy: { name: req.user.name, email: req.user.email } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Record not found' });
    await notificationStore.send([target._id.toString()], {
      type: 'warn',
      message: `📌 You have been assigned to handle: ${doc.issueKey}`,
      data: { issueKey: doc.issueKey },
    });
    res.json({ success: true, assignedTo });
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  app.get('/api/notifications', requireAuth, async (req, res) => {
    res.json(await notificationStore.getForUser(req.user.id));
  });
  app.get('/api/notifications/stream', requireAuth, (req, res) => {
    sseHeaders(res);
    const unsub = notificationStore.register(req.user.id, res);
    req.on('close', unsub);
  });
  app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
    await notificationStore.markRead(req.user.id, req.params.id);
    res.json({ success: true });
  });
  app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
    await notificationStore.markAllRead(req.user.id);
    res.json({ success: true });
  });

  // ── History ───────────────────────────────────────────────────────────────
  app.get('/api/history/approvals', requireAuth, async (_req, res) => {
    res.json(await ApprovalHistory.find().sort({ createdAt: -1 }).limit(100));
  });
  app.get('/api/history/escalations', requireAuth, async (_req, res) => {
    res.json(await EscalationHistory.find().sort({ escalatedAt: -1 }).limit(100));
  });

  // ── Lightweight member list — any authenticated user can fetch names for filters
  app.get('/api/users/members', requireAuth, async (_req, res) => {
    try {
      const members = await User.find({ active: { $ne: false } })
        .select('_id name role email').sort({ name: 1 }).lean();
      res.json(members);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── User management (admin only) ──────────────────────────────────────────
  app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
    res.json(await userService.list());
  });
  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    try { res.status(201).json(await userService.create(req.body)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });
  app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await userService.update(req.params.id, req.body)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });
  app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await userService.delete(req.params.id, req.user.id)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  // ── Cluster pod health ────────────────────────────────────────────────────
  app.get('/api/cluster/pods', requireAuth, async (_req, res) => {
    try { res.json(await clusterService.getPodHealth(CONFIG_PATH)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Chat config (returns LLM settings for the UI) ────────────────────────
  app.get('/api/chat/config', requireAuth, (_req, res) => {
    res.json({
      model:   process.env.OPENAI_MODEL   || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
      apiKey:  process.env.OPENAI_API_KEY  || '',
    });
  });

  // ── Chat system prompt ────────────────────────────────────────────────────
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

  // ── Chat — full response (no streaming) ───────────────────────────────────
  app.post('/api/chat', requireAuth, async (req, res) => {
    const { messages, apiKey, baseURL, model } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    // Allow overriding credentials from the UI (test mode)
    const client = (apiKey || baseURL)
      ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
      : llm;

    const t0 = Date.now();
    try {
      // Scaleway/Qwen always streams — collect chunks into a full response
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
  });

  // ── Chat — cluster context snapshot (read-only) ──────────────────────────
  app.get('/api/chat/cluster-context', requireAuth, async (_req, res) => {
    try {
      const text = await buildClusterContext();
      res.json({ text, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chat — streaming (SSE) ────────────────────────────────────────────────
  app.post('/api/chat/stream', requireAuth, async (req, res) => {
    const { messages, apiKey, baseURL, model, withClusterContext } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    const client = (apiKey || baseURL)
      ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
      : llm;

    // In cluster mode the frontend already enriched the latest user message
    // with a live cluster snapshot (prefixed "[LIVE CLUSTER DATA]").
    // Here we only need to switch to the cluster-focused system prompt so the
    // model knows it has real data in front of it rather than training defaults.
    const systemPrompt = withClusterContext
      ? `You are KubePilot AI, embedded inside the KubePilot Kubernetes management dashboard. You have READ-ONLY access to the user's live cluster — the dashboard backend fetched the real pod state, escalations, and alerts and the user has included that data directly in their message.

RULES:
- The user's message starts with "[LIVE CLUSTER DATA]" followed by the real cluster snapshot. Use it to answer accurately.
- NEVER say you cannot access the cluster — you can see the data right in the message.
- Reference specific pod names, namespaces, phases, restart counts from the snapshot.
- You are read-only: describe and analyze, do not execute kubectl yourself.
- If more detail is needed, tell the user which kubectl command to run.
- Be concise. Lead with the key finding, then the explanation.`
      : CHAT_SYSTEM_PROMPT;
    const finalMessages = messages;

    sseHeaders(res);
    const t0 = Date.now();
    try {
      const stream = await client.chat.completions.create({
        model:       model || process.env.OPENAI_MODEL,
        temperature: 0.7,
        stream:      true,
        messages: [
          { role: 'system', content: systemPrompt },
          ...finalMessages,
        ],
      });
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true, elapsed: Date.now() - t0 })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.end();
  });

  // ── PDF report — LLM structures the content, client renders it ──────────────
  app.post('/api/chat/pdf-report', requireAuth, async (req, res) => {
    const { messages, reportContent } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages required' });

    // Use the exact assistant message the user is downloading, so the PDF
    // matches what was shown in chat. Fall back to re-summarising the thread
    // only when no specific message content was passed.
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
  });

  // ── Chat history (per-user, persisted in MongoDB) ────────────────────────────
  app.get('/api/chat/history', requireAuth, async (req, res) => {
    try {
      const doc = await ChatHistory.findOne({ userId: req.user.id });
      res.json({ messages: doc?.messages || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/chat/history', requireAuth, async (req, res) => {
    try {
      const { messages } = req.body;
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
      await ChatHistory.findOneAndUpdate(
        { userId: req.user.id },
        { messages },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/chat/history', requireAuth, async (req, res) => {
    try {
      await ChatHistory.findOneAndUpdate({ userId: req.user.id }, { messages: [] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Command history (per-user, persisted in MongoDB) ─────────────────────
  app.get('/api/command/history', requireAuth, async (req, res) => {
    try {
      const doc = await CommandHistory.findOne({ userId: req.user.id });
      res.json({ turns: doc?.turns ?? [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/command/history', requireAuth, async (req, res) => {
    try {
      const { turns } = req.body;
      if (!Array.isArray(turns)) return res.status(400).json({ error: 'turns array required' });
      await CommandHistory.findOneAndUpdate(
        { userId: req.user.id },
        { turns: turns.slice(-50) },   // cap at 50 turns per user
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/command/history', requireAuth, async (req, res) => {
    try {
      await CommandHistory.findOneAndUpdate({ userId: req.user.id }, { turns: [] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Manual command orders (Orders chat panel) ────────────────────────────────
  app.post('/api/command/interpret', requireAuth, async (req, res) => {
    const { order } = req.body;
    if (!order?.trim()) return res.status(400).json({ error: 'order is required' });

    // ── Cluster provisioning intent — intercept before LLM ────────────────────
    const PROVISION_RE = /\b(create|start|provision|spin\s*up|add|new)\s+(cluster|minikube)\s+(?:named?\s+)?([a-z0-9][a-z0-9\-]*)/i;
    const pm = PROVISION_RE.exec(order.trim());
    if (pm) {
      const profile = pm[3].toLowerCase();
      const tier = /prod/i.test(order) ? 'production' : /stag/i.test(order) ? 'staging' : 'dev';
      return res.json({
        type:        'provision',
        understood:  `Create new Minikube cluster: ${profile}`,
        profileName: profile,
        tier,
        command:     `minikube start --profile ${profile}`,
        risk:        'MEDIUM',
        riskReason:  'Creates a new local Kubernetes cluster. Takes 1–5 minutes.',
        explanation: `Runs minikube start --profile ${profile}, then auto-adds "${profile}" to KubePilot monitoring with tier: ${tier}.`,
        category:    'provision',
      });
    }

    let clusters = [];
    try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}

    const clusterList = clusters.length
      ? clusters.map(c =>
          `- ${c.name} (context: ${c.context}, tier: ${c.tier ?? 'dev'}, namespaces: ${(c.namespaces ?? ['default']).join(', ')})`
        ).join('\n')
      : '(no clusters configured yet)';

    const prompt = `You are a Kubernetes ops assistant. Do two things at once:
1. Convert the user order into a single kubectl command.
2. Classify and assess the safety of that command.

Available clusters:
${clusterList}

User order: "${order}"

━━━ COMMAND GENERATION RULES ━━━
- Always include --context=<context> using the matching cluster context.
- Always include -n <namespace> (use "default" if not specified).
- Generate exactly one kubectl command.
- NEVER invent flags that do not exist. Use only real kubectl syntax.

CORRECT command examples (use these exact forms):
  List pods        → kubectl --context=CTX get pods -n NS
  Describe pod     → kubectl --context=CTX describe pod POD -n NS
  Pod logs         → kubectl --context=CTX logs POD -n NS --tail=50
  Restart deploy   → kubectl --context=CTX rollout restart deployment/NAME -n NS
  Rollback deploy  → kubectl --context=CTX rollout undo deployment/NAME -n NS
  Scale replicas   → kubectl --context=CTX scale deployment/NAME --replicas=N -n NS
  Delete pod       → kubectl --context=CTX delete pod POD -n NS
  Set memory       → kubectl --context=CTX set resources deployment/NAME --limits=memory=256Mi --requests=memory=128Mi -n NS
  Get deployments  → kubectl --context=CTX get deployments -n NS
  Rollout status   → kubectl --context=CTX rollout status deployment/NAME -n NS

⛔ NEVER use these wrong forms:
  kubectl run NAME --replicas=N   ← WRONG (kubectl run creates a pod, has no --replicas)
  kubectl create deployment NAME --replicas=N  ← WRONG for changing existing replicas

━━━ SAFETY CLASSIFICATION RULES ━━━
- category: one of "read-only" | "rolling-update" | "scaling" | "config-change" | "destructive"
  · read-only     → get, describe, logs, top, rollout status (no side effects)
  · rolling-update → rollout restart, rollout undo (pods recycled)
  · scaling       → scale replicas up or down
  · config-change → set resources, patch, apply (changes live config)
  · destructive   → delete pod/deployment/namespace, force ops
- risk: "LOW" | "MEDIUM" | "HIGH"
  · LOW    → read-only
  · MEDIUM → rolling-update or scaling
  · HIGH   → config-change or destructive
- riskReason: one short sentence explaining WHY this risk level was assigned.

Return ONLY valid JSON (no markdown):
{
  "understood": "plain English summary of what you will do",
  "command": "the full kubectl command string",
  "category": "one of the five categories above",
  "risk": "LOW or MEDIUM or HIGH",
  "riskReason": "why this risk level",
  "explanation": "one sentence: what the command does and any notable side effects"
}`;

    try {
      const stream = await llm.chat.completions.create({
        model: process.env.OPENAI_MODEL, temperature: 0.1, stream: true,
        messages: [
          { role: 'system', content: 'You are a Kubernetes SRE. Output ONLY valid JSON. No markdown.' },
          { role: 'user',   content: prompt },
        ],
      });
      let raw = '';
      for await (const chunk of stream) raw += chunk.choices[0]?.delta?.content ?? '';

      let plan;
      try { plan = JSON.parse(raw); }
      catch { return res.status(422).json({ error: 'LLM returned unparseable response', raw }); }

      if (!plan.command?.trim()) return res.status(422).json({ error: 'LLM did not return a command' });

      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Command error diagnosis ───────────────────────────────────────────────
  app.post('/api/command/diagnose', requireAuth, async (req, res) => {
    const { order, command, error } = req.body;
    if (!order?.trim() || !error?.trim())
      return res.status(400).json({ error: 'order and error are required' });

    let clusters = [];
    try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}

    const clusterList = clusters.length
      ? clusters.map(c =>
          `- ${c.name} (context: ${c.context}, tier: ${c.tier ?? 'dev'}, namespaces: ${(c.namespaces ?? ['default']).join(', ')})`
        ).join('\n')
      : '(no clusters configured yet)';

    const prompt = `A user tried to execute a kubectl command and it failed. Diagnose the problem and suggest a concrete fix.

Available clusters:
${clusterList}

User wanted to: "${order}"
Command tried: ${command ? `\`${command}\`` : '(command not generated)'}
Error received: ${error}

Think about:
- Does the resource actually exist? (e.g. Deployment vs bare Pod vs ReplicaSet)
- Is the resource type correct for what the user wants to do?
- Is there a corrected command that would achieve the user's actual goal?

Return ONLY valid JSON (no markdown, no extra text):
{
  "diagnosis": "one sentence: what went wrong and why",
  "suggestion": "one or two sentences: what the user should do to achieve their goal",
  "fixedCommand": "full corrected kubectl command if applicable, or null"
}`;

    try {
      const stream = await llm.chat.completions.create({
        model: process.env.OPENAI_MODEL, temperature: 0.2, stream: true,
        messages: [
          { role: 'system', content: 'You are a Kubernetes SRE. Output ONLY valid JSON. No markdown.' },
          { role: 'user',   content: prompt },
        ],
      });
      let raw = '';
      for await (const chunk of stream) raw += chunk.choices[0]?.delta?.content ?? '';

      let result;
      try { result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw); }
      catch { return res.status(422).json({ error: 'LLM returned unparseable response' }); }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cluster provisioning ──────────────────────────────────────────────────
  app.post('/api/cluster/provision/start', requireAuth, (req, res) => {
    try {
      const jobId = provisionService.startJob(req.body.profile, req.body.tier, req.user.name, CONFIG_PATH);
      res.json({ jobId });
    } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  app.get('/api/cluster/provision/status', requireAuth, (req, res) => {
    const job = provisionService.getJob(req.query.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ status: job.status, log: job.log, error: job.error ?? null, profile: job.profile });
  });

  app.post('/api/command/execute', requireAuth, async (req, res) => {
    const { command } = req.body;
    if (!command?.trim()) return res.status(400).json({ error: 'command is required' });

    console.log(`[CMD] ${req.user.name} → ${command}`);
    try {
      const output = await kubectl.runCommand(command);
      res.json({ success: true, output: output || '(command completed with no output)' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Prometheus metrics endpoints ──────────────────────────────────────────
  // ── Token usage ───────────────────────────────────────────────────────────
  app.get('/api/tokens', requireAuth, (_req, res) => res.json(tokenStore.getAll()));
  app.post('/api/tokens/reset', requireAuth, requireAdmin, (_req, res) => {
    tokenStore.reset();
    res.json({ ok: true });
  });

  // ── Prometheus metrics endpoints ──────────────────────────────────────────
  app.get('/api/metrics/status', requireAuth, (_req, res) => {
    res.json({
      available: metricsCollector.isAvailable(),
      url:       process.env.PROMETHEUS_URL || 'http://localhost:9090',
    });
  });

  app.get('/api/metrics/errors', requireAuth, async (_req, res) => {
    try {
      const errors = await metricsCollector.getErrors();
      res.json({ errors, prometheusAvailable: metricsCollector.isAvailable() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/metrics/pods — all-pods Prometheus metrics (CPU, memory, restarts, OOM)
  app.get('/api/metrics/pods', requireAuth, async (_req, res) => {
    try {
      if (!metricsCollector.isAvailable())
        return res.json({ available: false, pods: [] });

      const [metricsMap, errors] = await Promise.all([
        metricsCollector.collectAllPodsMetrics(),
        metricsCollector.getErrors(),
      ]);

      // Build OOM + HighRestarts lookup from errors
      const oomSet     = new Set(errors.filter(e => e.type === 'OOMKilled').map(e => `${e.namespace}/${e.pod}`));
      const errTypeMap = {};
      for (const e of errors) {
        const k = `${e.namespace}/${e.pod}`;
        if (!errTypeMap[k]) errTypeMap[k] = [];
        errTypeMap[k].push(e.type);
      }

      // Union metricsMap keys (CPU/memory) with error keys (kube-state-metrics)
      // so pods with errors always appear even before cAdvisor data is available.
      const allKeys = new Set([
        ...Object.keys(metricsMap ?? {}),
        ...errors.filter(e => e.namespace && e.pod).map(e => `${e.namespace}/${e.pod}`),
      ]);

      const pods = [...allKeys].map(key => {
        const [namespace, pod] = key.split('/');
        const m = (metricsMap ?? {})[key] ?? {};
        return {
          key, namespace, pod,
          cpuCores:   m.cpuCores  ?? null,
          memBytes:   m.memBytes  ?? null,
          restarts:   m.restarts  ?? 0,
          oomKilled:  oomSet.has(key),
          errorTypes: errTypeMap[key] ?? [],
        };
      });

      // Sort: pods with errors first, then by restarts desc
      pods.sort((a, b) => {
        const aHasErr = a.errorTypes.length > 0 ? 1 : 0;
        const bHasErr = b.errorTypes.length > 0 ? 1 : 0;
        if (bHasErr !== aHasErr) return bHasErr - aHasErr;
        return (b.restarts ?? 0) - (a.restarts ?? 0);
      });

      res.json({ available: true, pods });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Node health endpoints ─────────────────────────────────────────────────
  const kubectl_tool     = require('../tools/kubectl');
  const NodeAnalyzer_srv = require('../agents/nodeAnalyzer');
  const EventAnalyzer_srv = require('../agents/eventAnalyzer');

  // GET /api/nodes — all nodes with status, conditions, Prometheus metrics
  app.get('/api/nodes', requireAuth, async (req, res) => {
    try {
      const clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
      const allNodeMetrics = await metricsCollector.collectAllNodesMetrics().catch(() => null);

      const result = await Promise.all(clusters.map(async cluster => {
        try {
          const nodesJson  = await kubectl_tool.getNodes(cluster.context);
          const nodeMap    = NodeAnalyzer_srv.buildNodeMap(nodesJson);
          const nodeIssues = NodeAnalyzer_srv.extractIssues(nodesJson, {}, allNodeMetrics ?? {});

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
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/events — recent warning events across all clusters
  app.get('/api/events', requireAuth, async (_req, res) => {
    try {
      const clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
      const all = [];
      await Promise.all(clusters.map(async cluster => {
        try {
          const eventsJson = await kubectl_tool.getEvents(cluster.context);
          const events     = EventAnalyzer_srv.extractEvents(eventsJson);
          all.push(...events.map(e => ({ ...e, clusterName: cluster.name })));
        } catch { /* cluster unreachable */ }
      }));
      all.sort((a, b) => b.count - a.count);
      res.json({ events: all.slice(0, 200) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/metrics/nodes — batch Prometheus node metrics
  app.get('/api/metrics/nodes', requireAuth, async (_req, res) => {
    try {
      if (!metricsCollector.isAvailable())
        return res.json({ available: false, nodes: {} });
      const nodeMetrics = await metricsCollector.collectAllNodesMetrics();
      res.json({ available: true, nodes: nodeMetrics ?? {} });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Profile ───────────────────────────────────────────────────────────────

  // Request OTP for password change via email
  app.post('/api/profile/request-otp', requireAuth, async (req, res) => {
    try { res.json(await profileService.requestOtp(req.user)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  app.get('/api/profile/email-available', requireAuth, (_req, res) => {
    res.json({ available: profileService.isEmailConfigured() });
  });

  app.get('/api/profile/stats', requireAuth, async (req, res) => {
    try { res.json(await profileService.getStats(req.user.id, req.user.email)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/profile', requireAuth, async (req, res) => {
    try { res.json(await profileService.updateProfile(req.user.id, req.body)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  app.get('/api/profile/activity', requireAuth, async (req, res) => {
    try { res.json(await profileService.getActivity(req.user.id, req.user.email)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/users/:id/profile', requireAuth, requireAdmin, async (req, res) => {
    try { res.json(await profileService.getAdminView(req.params.id)); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  // ── Kubernetes context discovery ────────────────────────────────────────────
  app.get('/api/kube/contexts', requireAuth, async (_req, res) => {
    try { res.json({ contexts: await clusterService.getContexts(CONFIG_PATH) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Update monitored clusters config (admin only) ────────────────────────
  app.put('/api/kube/clusters', requireAuth, requireAdmin, (req, res) => {
    try { clusterService.validateAndSaveConfig(CONFIG_PATH, req.body.clusters); res.json({ ok: true }); }
    catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  // ── Notification Settings ─────────────────────────────────────────────────────
  const {
    NotificationChannelConfig, NotificationRoutingConfig,
    NotificationDeliveryLog, UserNotificationPreferences,
  } = require('../db/models');
  const notifCrypto  = require('../services/notifications/crypto');
  const notifEngine  = require('../services/notifications/engine');

  const CATEGORIES = ['Cluster Health','Resource Usage','Security','Deployments',
                      'Cost Optimization','Autoscaling','Incidents','Agent Actions',
                      'Recommendations','Reports'];

  // ── Per-user preferences (all authenticated users) ────────────────────────

  // GET /api/notifications/preferences — own prefs
  app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
    try {
      const doc = await UserNotificationPreferences.findOne({ userId: req.user.id }).lean();
      res.json(doc ?? { userId: req.user.id, channels: ['inApp'], categories: [], notifyEmail: req.user.email ?? '' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/notifications/preferences — save own prefs
  app.put('/api/notifications/preferences', requireAuth, async (req, res) => {
    try {
      const { channels, categories, notifyEmail } = req.body;
      await UserNotificationPreferences.findOneAndUpdate(
        { userId: req.user.id },
        { channels: channels ?? ['inApp'], categories: categories ?? [], notifyEmail: notifyEmail ?? '' },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/notifications/preferences/test-email — send a test email to own notification email
  app.post('/api/notifications/preferences/test-email', requireAuth, async (req, res) => {
    try {
      // Resolve destination: saved notifyEmail → account email → error
      const pref    = await UserNotificationPreferences.findOne({ userId: req.user.id }).lean();
      const toEmail = pref?.notifyEmail || req.user.email;
      if (!toEmail) return res.json({ ok: false, message: 'No email address configured' });

      // Load SMTP config from system channel settings
      const channelDoc = await NotificationChannelConfig.findOne({ type: 'email' }).lean();
      if (!channelDoc?.enabled) return res.json({ ok: false, message: 'Email channel is not enabled. Ask your admin to configure it first.' });

      const emailProvider = require('../services/notifications/providers/email');
      const cfg = notifCrypto.decrypt(channelDoc.config ?? '');

      await emailProvider.send({
        severity: 'INFO',
        category: 'Recommendations',
        title:    'KubePilot — Test Notification',
        message:  `This is a test notification sent to ${toEmail}. Your email notifications are working correctly.`,
        source:   'KubePilot Notification Center',
      }, { ...cfg, recipients: toEmail });

      res.json({ ok: true, message: `Test email sent to ${toEmail}` });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  // GET /api/notifications/admin/users-preferences — admin: all users + their prefs
  app.get('/api/notifications/admin/users-preferences', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [users, prefs] = await Promise.all([
        User.find({ active: true }).select('_id name email role').lean(),
        UserNotificationPreferences.find().lean(),
      ]);
      const prefsById = Object.fromEntries(prefs.map(p => [p.userId, p]));
      res.json(users.map(u => ({
        userId:      u._id.toString(),
        name:        u.name,
        email:       u.email,
        role:        u.role,
        prefs:       prefsById[u._id.toString()] ?? { channels: ['inApp'], categories: [], notifyEmail: u.email },
      })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const CHANNEL_TYPES = ['teams', 'email', 'slack', 'inApp', 'telegram', 'discord', 'webhook'];

  // GET /api/notifications/channels — list all channels with masked config
  app.get('/api/notifications/channels', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const docs = await NotificationChannelConfig.find().lean();
      const byType = Object.fromEntries(docs.map(d => [d.type, d]));
      const result = CHANNEL_TYPES.map(type => {
        const doc = byType[type];
        const cfg = doc ? notifCrypto.decrypt(doc.config ?? '') : {};
        return { type, enabled: doc?.enabled ?? false, config: notifCrypto.mask(cfg), updatedAt: doc?.updatedAt };
      });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/notifications/channels/:type — save channel config
  app.put('/api/notifications/channels/:type', requireAuth, requireAdmin, async (req, res) => {
    const { type } = req.params;
    if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
    try {
      const { enabled, config } = req.body;
      const existing = await NotificationChannelConfig.findOne({ type }).lean();
      // Merge: keep stored secrets for masked ('••••••••') fields sent back from frontend
      const stored  = existing ? notifCrypto.decrypt(existing.config ?? '') : {};
      const merged  = { ...stored };
      for (const [k, v] of Object.entries(config ?? {})) {
        if (v !== '••••••••') merged[k] = v;
      }
      await NotificationChannelConfig.findOneAndUpdate(
        { type },
        { type, enabled: enabled ?? false, config: notifCrypto.encrypt(merged), updatedBy: req.user.name },
        { upsert: true }
      );
      notifEngine.invalidateRoutingCache();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/notifications/channels/:type/test — test channel connectivity
  app.post('/api/notifications/channels/:type/test', requireAuth, requireAdmin, async (req, res) => {
    const { type } = req.params;
    if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
    try {
      const provider = notifEngine.PROVIDERS[type];
      if (!provider) return res.status(400).json({ error: 'Provider not available' });

      // Resolve config: merge stored + any overrides sent in body (unmasked)
      const existing = await NotificationChannelConfig.findOne({ type }).lean();
      const stored   = existing ? notifCrypto.decrypt(existing.config ?? '') : {};
      const override = req.body.config ?? {};
      const merged   = { ...stored };
      for (const [k, v] of Object.entries(override)) {
        if (v !== '••••••••') merged[k] = v;
      }

      await provider.testConnection(merged);
      res.json({ ok: true, message: 'Connection successful' });
    } catch (err) { res.status(200).json({ ok: false, message: err.message }); }
  });

  // GET /api/notifications/routing — get routing rules
  app.get('/api/notifications/routing', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const doc = await NotificationRoutingConfig.findOne().lean();
      res.json(doc?.routing ?? { INFO: ['inApp'], WARNING: ['inApp','teams'], ERROR: ['inApp','teams','email'], CRITICAL: ['inApp','teams','email','slack'] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/notifications/routing — save routing rules
  app.put('/api/notifications/routing', requireAuth, requireAdmin, async (req, res) => {
    try {
      await NotificationRoutingConfig.findOneAndUpdate({}, { routing: req.body }, { upsert: true });
      notifEngine.invalidateRoutingCache();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/notifications/subscriptions — event category subscriptions per channel
  app.get('/api/notifications/subscriptions', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const doc = await NotificationRoutingConfig.findOne().lean();
      res.json(doc?.subscriptions ?? {});
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/notifications/subscriptions
  app.put('/api/notifications/subscriptions', requireAuth, requireAdmin, async (req, res) => {
    try {
      await NotificationRoutingConfig.findOneAndUpdate({}, { subscriptions: req.body }, { upsert: true });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/notifications/delivery-log?page=1&limit=50&channel=&status=
  app.get('/api/notifications/delivery-log', requireAuth, requireAdmin, async (req, res) => {
    try {
      const page    = Math.max(1, parseInt(req.query.page  ?? '1',  10));
      const limit   = Math.min(100, parseInt(req.query.limit ?? '50', 10));
      const filter  = {};
      if (req.query.channel) filter.channel = req.query.channel;
      if (req.query.status)  filter.status  = req.query.status;
      const [docs, total] = await Promise.all([
        NotificationDeliveryLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        NotificationDeliveryLog.countDocuments(filter),
      ]);
      res.json({ docs, total, page, pages: Math.ceil(total / limit) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.listen(port, () => console.log(`[API] Dashboard server on http://localhost:${port}`));
}

module.exports = { createServer };
