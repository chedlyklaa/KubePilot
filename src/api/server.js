const express             = require('express');
const cors                = require('cors');
const yaml                = require('js-yaml');
const fs                  = require('fs');
const path                = require('path');
const llm                 = require('./llmClient');
const kubectl             = require('../tools/kubectl');
const logStore            = require('./logStore');
const approvalStore       = require('./approvalStore');
const escalationStore     = require('./escalationStore');
const notificationStore   = require('./notificationStore');
const authService         = require('./authService');
const { User, ApprovalHistory, EscalationHistory, ChatHistory, CommandHistory } = require('../db/models');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

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

function createServer(port = 3001) {
  const app = express();
  app.use(cors());
  app.use(express.json());

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
    sseHeaders(res);
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

  // ── User management (admin only) ──────────────────────────────────────────
  app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
    res.json(await User.find().select('-password').sort({ createdAt: 1 }));
  });
  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name required' });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'Email already in use' });
    const u = await User.create({ email, password, name, role: role || 'developer' });
    res.status(201).json({ id: u._id, email: u.email, name: u.name, role: u.role });
  });
  app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { name, role, password, active } = req.body;
    const upd = {};
    if (name     !== undefined) upd.name     = name;
    if (role     !== undefined) upd.role     = role;
    if (password !== undefined) upd.password = password;
    if (active   !== undefined) upd.active   = active;
    const u = await User.findByIdAndUpdate(req.params.id, upd, { new: true }).select('-password');
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json(u);
  });
  app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  });

  // ── Cluster pod health ────────────────────────────────────────────────────
  app.get('/api/cluster/pods', requireAuth, async (_req, res) => {
    let clusters = [];
    try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}

    const GPU_RESOURCES = ['nvidia.com/gpu', 'amd.com/gpu', 'intel.com/gpu', 'gpu.intel.com/i915'];

    // Parse a Kubernetes memory/cpu string into a number (bytes for memory, millicores for cpu)
    function parseK8sQuantity(str) {
      if (!str) return null;
      const n = parseFloat(str);
      if (str.endsWith('Ki')) return n * 1024;
      if (str.endsWith('Mi')) return n * 1024 ** 2;
      if (str.endsWith('Gi')) return n * 1024 ** 3;
      if (str.endsWith('Ti')) return n * 1024 ** 4;
      if (str.endsWith('m'))  return n;           // millicores
      if (str.endsWith('k'))  return n * 1000;
      return n;
    }

    // Parse `kubectl top pods --no-headers` plain-text output into a map
    function parseTopOutput(raw, namespace) {
      const map = {};
      for (const line of (raw ?? '').split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const [name, cpu, memory] = parts;
          map[`${namespace}/${name}`] = {
            cpuRaw:    cpu,
            memRaw:    memory,
            cpuMilli:  parseK8sQuantity(cpu),
            memBytes:  parseK8sQuantity(memory),
          };
        }
      }
      return map;
    }

    const results = await Promise.allSettled(clusters.map(async cluster => {
      const { name, context: ctx, tier = 'dev', namespaces: ns = ['default'] } = cluster;

      const rawPods = [];
      const metricsMap = {};

      await Promise.allSettled(ns.map(async namespace => {
        // Pod list
        try {
          const json = await kubectl.getPods(namespace, ctx, true);
          rawPods.push(...(json.items ?? []));
        } catch (err) {
          console.warn(`[HEALTH] ${name}/${namespace} pods: ${err.message}`);
        }
        // Live metrics (requires metrics-server — best-effort)
        try {
          const topOut = await kubectl.runCommand(
            `kubectl --context=${ctx} top pods -n ${namespace} --no-headers`
          );
          Object.assign(metricsMap, parseTopOutput(topOut, namespace));
        } catch { /* metrics-server not installed — skip */ }
      }));

      const pods = rawPods.map(pod => {
        const meta      = pod.metadata  ?? {};
        const spec      = pod.spec      ?? {};
        const status    = pod.status    ?? {};
        const csArr     = status.containerStatuses ?? [];
        const icArr     = status.initContainerStatuses ?? [];
        const allCS     = [...csArr, ...icArr];

        const readyCount = csArr.filter(c => c.ready).length;
        const totalCount = csArr.length;
        const restarts   = allCS.reduce((s, c) => s + (c.restartCount ?? 0), 0);
        const readyCond  = (status.conditions ?? []).find(c => c.type === 'Ready');

        const containers = (spec.containers ?? []).map(c => {
          const lim  = c.resources?.limits   ?? {};
          const req  = c.resources?.requests ?? {};
          const cs   = csArr.find(x => x.name === c.name) ?? {};
          const gpu  = GPU_RESOURCES.reduce((v, k) => v ?? lim[k] ?? req[k] ?? null, null);
          return {
            name:          c.name,
            image:         c.image,
            ready:         cs.ready         ?? false,
            state:         Object.keys(cs.state ?? { waiting: true })[0],
            reason:        cs.state?.waiting?.reason ?? cs.state?.terminated?.reason ?? null,
            restartCount:  cs.restartCount  ?? 0,
            memLimitBytes: parseK8sQuantity(lim.memory   ?? null),
            memReqBytes:   parseK8sQuantity(req.memory   ?? null),
            cpuLimitMilli: parseK8sQuantity(lim.cpu      ?? null),
            cpuReqMilli:   parseK8sQuantity(req.cpu      ?? null),
            gpuRequested:  gpu ? parseInt(gpu, 10) : 0,
          };
        });

        const metricKey = `${meta.namespace}/${meta.name}`;
        const metrics   = metricsMap[metricKey] ?? null;

        return {
          name:       meta.name,
          namespace:  meta.namespace ?? 'default',
          phase:      status.phase   ?? 'Unknown',
          ready:      `${readyCount}/${totalCount}`,
          isReady:    readyCond?.status === 'True',
          restarts,
          node:       spec.nodeName  ?? '—',
          startTime:  status.startTime ?? null,
          containers,
          // Live metrics
          cpuRaw:    metrics?.cpuRaw    ?? null,
          cpuMilli:  metrics?.cpuMilli  ?? null,
          memRaw:    metrics?.memRaw    ?? null,
          memBytes:  metrics?.memBytes  ?? null,
          hasMetrics: !!metrics,
          // Aggregate limits across containers
          totalMemLimitBytes: containers.reduce((s, c) => s != null && c.memLimitBytes != null ? s + c.memLimitBytes : null, 0) || null,
          totalGpu:           containers.reduce((s, c) => s + c.gpuRequested, 0),
        };
      });

      return { name, context: ctx, tier, connected: true, podCount: pods.length, pods };
    }));

    const data = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : {
        name:      clusters[i].name,
        context:   clusters[i].context,
        tier:      clusters[i].tier ?? 'dev',
        connected: false,
        podCount:  0,
        pods:      [],
        error:     r.reason?.message ?? 'Failed to connect',
      }
    );

    res.json({ clusters: data, timestamp: new Date().toISOString() });
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

  // ── Chat — streaming (SSE) ────────────────────────────────────────────────
  app.post('/api/chat/stream', requireAuth, async (req, res) => {
    const { messages, apiKey, baseURL, model } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    const client = (apiKey || baseURL)
      ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
      : llm;

    sseHeaders(res);
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

  app.listen(port, () => console.log(`[API] Dashboard server on http://localhost:${port}`));
}

module.exports = { createServer };
