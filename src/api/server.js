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

const metricsCollector = require('../monitoring/metricsCollector');
const emailService     = require('../notifications/email');

// In-memory OTP store for password-change email verification
// userId → { otp, expiresAt, issuedAt }
const otpStore = new Map();

// Sweep expired OTP entries every 15 minutes (mirrors authService token cleanup)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of otpStore) {
    if (now > entry.expiresAt) otpStore.delete(id);
  }
}, 15 * 60 * 1000).unref();

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
    if (name     !== undefined) { if (!name?.trim()) return res.status(400).json({ error: 'Name cannot be empty' }); upd.name = name.trim(); }
    if (role     !== undefined) upd.role     = role;
    if (password !== undefined) upd.password = password;
    if (active   !== undefined) upd.active   = active;
    const u = await User.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true }).select('-password');
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

    // Parse `kubectl top pods -n <ns> --no-headers` — 3 columns: NAME CPU MEM
    function parseTopOutput(raw, namespace) {
      const map = {};
      for (const line of (raw ?? '').split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const [name, cpu, memory] = parts;
          map[`${namespace}/${name}`] = {
            cpuRaw: cpu, memRaw: memory,
            cpuMilli: parseK8sQuantity(cpu), memBytes: parseK8sQuantity(memory),
          };
        }
      }
      return map;
    }

    // Parse `kubectl top pods --all-namespaces --no-headers` — 4 columns: NS NAME CPU MEM
    function parseTopOutputAllNs(raw) {
      const map = {};
      for (const line of (raw ?? '').split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const [ns, name, cpu, memory] = parts;
          map[`${ns}/${name}`] = {
            cpuRaw: cpu, memRaw: memory,
            cpuMilli: parseK8sQuantity(cpu), memBytes: parseK8sQuantity(memory),
          };
        }
      }
      return map;
    }

    // Fetch Prometheus batch metrics once for all clusters (cached 60 s)
    let prometheusMap = {};
    if (metricsCollector.isAvailable()) {
      try { prometheusMap = await metricsCollector.collectAllPodsMetrics() ?? {}; } catch {}
    }

    const results = await Promise.allSettled(clusters.map(async cluster => {
      const { name, context: ctx, tier = 'dev', namespaces: ns = ['default'] } = cluster;

      const rawPods   = [];
      const metricsMap = {};
      const allNs     = ns.includes('*');

      if (allNs) {
        // Both calls are independent — run them in parallel
        await Promise.allSettled([
          (async () => {
            try {
              const json = await kubectl.getPods('*', ctx, true);
              rawPods.push(...(json.items ?? []));
            } catch (err) {
              console.warn(`[HEALTH] ${name}/all-namespaces pods: ${err.message}`);
            }
          })(),
          (async () => {
            try {
              const topOut = await kubectl.runCommand(
                `kubectl --context=${ctx} top pods --all-namespaces --no-headers`
              );
              Object.assign(metricsMap, parseTopOutputAllNs(topOut));
            } catch { /* metrics-server not available */ }
          })(),
        ]);
      } else {
        await Promise.allSettled(ns.map(async namespace => {
          try {
            const json = await kubectl.getPods(namespace, ctx, true);
            rawPods.push(...(json.items ?? []));
          } catch (err) {
            console.warn(`[HEALTH] ${name}/${namespace} pods: ${err.message}`);
          }
          try {
            const topOut = await kubectl.runCommand(
              `kubectl --context=${ctx} top pods -n ${namespace} --no-headers`
            );
            Object.assign(metricsMap, parseTopOutput(topOut, namespace));
          } catch { /* metrics-server not available */ }
        }));
      }

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

        const metricKey   = `${meta.namespace}/${meta.name}`;
        const topMetrics  = metricsMap[metricKey]    ?? null;  // kubectl top
        const promMetrics = prometheusMap[metricKey] ?? null;  // Prometheus batch

        // Prefer kubectl top (instantaneous); fall back to Prometheus (5-min average)
        const cpuRaw   = topMetrics?.cpuRaw
          ?? (promMetrics?.cpuCores != null ? `${(promMetrics.cpuCores * 100).toFixed(1)}%` : null);
        const memRaw   = topMetrics?.memRaw
          ?? (promMetrics?.memBytes != null ? fmtBytesServer(promMetrics.memBytes) : null);
        const cpuMilli = topMetrics?.cpuMilli
          ?? (promMetrics?.cpuCores != null ? promMetrics.cpuCores * 1000 : null);
        const memBytes = topMetrics?.memBytes ?? promMetrics?.memBytes ?? null;

        const metricsSource = topMetrics ? 'kubectl' : promMetrics ? 'prometheus' : null;

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
          // Live metrics (kubectl top preferred, Prometheus fallback)
          cpuRaw,
          cpuMilli,
          memRaw,
          memBytes,
          hasMetrics:    !!(topMetrics || promMetrics),
          metricsSource,
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

  // ── Cluster provisioning — polling approach ──────────────────────────────
  // SSE through the Vite dev proxy is unreliable for long-running processes.
  // Instead: start a job → return jobId → client polls /status every 2 s.
  const provisionJobs = new Map(); // jobId → job object

  // Auto-cleanup jobs older than 1 hour
  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [id, job] of provisionJobs) {
      if (job.createdAt < cutoff) provisionJobs.delete(id);
    }
  }, 900_000).unref();

  app.post('/api/cluster/provision/start', requireAuth, (req, res) => {
    const { profile, tier } = req.body;
    if (!profile || !/^[a-z0-9][a-z0-9\-]*$/.test(profile))
      return res.status(400).json({ error: 'invalid profile name' });

    const jobId = require('crypto').randomUUID();
    const job   = { status: 'running', log: '', profile, tier: tier ?? 'dev', createdAt: Date.now() };
    provisionJobs.set(jobId, job);

    console.log(`[PROVISION] minikube start --profile ${profile}  (user: ${req.user.name}  job: ${jobId})`);

    const { spawn } = require('child_process');
    const proc = spawn('minikube', ['start', '--profile', profile], {
      shell: true,
      env: { ...process.env, MINIKUBE_IN_STYLE: '0' },
    });

    proc.on('error', spawnErr => {
      job.status = 'failed';
      job.error  = spawnErr.code === 'ENOENT'
        ? 'minikube is not installed or not in PATH'
        : spawnErr.message;
    });

    proc.stdout.on('data', chunk => { job.log += chunk.toString(); });
    proc.stderr.on('data', chunk => { job.log += chunk.toString(); });

    proc.on('close', async code => {
      if (code === 0) {
        try {
          let clusters = [];
          try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
          if (!clusters.find(c => c.context === profile)) {
            clusters.push({ name: profile, context: profile, tier: tier ?? 'dev', namespaces: ['*'] });
            fs.writeFileSync(CONFIG_PATH, yaml.dump({ clusters }), 'utf8');
          }
        } catch { /* config write failure is non-fatal */ }
        job.status = 'done';
      } else {
        job.status = 'failed';
        job.error  = job.error ?? `minikube start exited with code ${code}`;
      }
    });

    res.json({ jobId });
  });

  app.get('/api/cluster/provision/status', requireAuth, (req, res) => {
    const job = provisionJobs.get(req.query.id);
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

  // ── Profile ───────────────────────────────────────────────────────────────

  // Request OTP for password change via email
  app.post('/api/profile/request-otp', requireAuth, async (req, res) => {
    try {
      if (!emailService.isConfigured())
        return res.status(503).json({ error: 'Email service is not configured on this server' });

      // Rate-limit: block re-issue if a valid OTP was sent less than 2 minutes ago
      const existing = otpStore.get(req.user.id);
      if (existing && Date.now() - existing.issuedAt < 2 * 60 * 1000)
        return res.status(429).json({ error: 'Please wait before requesting another code' });

      const otp = String(Math.floor(100000 + Math.random() * 900000));

      // Send FIRST — only store if delivery succeeds (Fix: was stored before send)
      await emailService.sendOtp(req.user.email, req.user.name, otp);
      otpStore.set(req.user.id, { otp, expiresAt: Date.now() + 10 * 60 * 1000, issuedAt: Date.now() });

      res.json({ sent: true });
    } catch (err) {
      console.error('[OTP] Failed to send email:', err.message);
      res.status(500).json({ error: 'Failed to send verification email: ' + err.message });
    }
  });

  // Check if email service is available
  app.get('/api/profile/email-available', requireAuth, (_req, res) => {
    res.json({ available: emailService.isConfigured() });
  });

  app.get('/api/profile/stats', requireAuth, async (req, res) => {
    try {
      const userId    = req.user.id;
      const userEmail = req.user.email;

      const since = new Date();
      since.setDate(since.getDate() - 30);

      // All 7 queries are independent — run in one Promise.all.
      // Use aggregation for chat/command counts to avoid loading full arrays into memory.
      const [
        escalationsHandled,
        escalationsFixed,
        approvalsDecided,
        [chatRes],
        [cmdRes],
        escsByDay,
        approvalsByDay,
      ] = await Promise.all([
        EscalationHistory.countDocuments({ 'acknowledgedBy.userId': userId }),
        EscalationHistory.countDocuments({ 'stateUpdatedBy.email': userEmail, status: 'fixed' }),
        ApprovalHistory.countDocuments({ 'decidedBy.email': userEmail }),
        ChatHistory.aggregate([
          { $match: { userId } },
          { $project: { count: { $size: { $filter: { input: { $ifNull: ['$messages', []] }, cond: { $eq: ['$$this.role', 'user'] } } } } } },
        ]),
        CommandHistory.aggregate([
          { $match: { userId } },
          { $project: { count: { $size: { $ifNull: ['$turns', []] } } } },
        ]),
        EscalationHistory.aggregate([
          { $match: { 'acknowledgedBy.userId': userId, acknowledgedAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$acknowledgedAt' } }, count: { $sum: 1 } } },
        ]),
        ApprovalHistory.aggregate([
          { $match: { 'decidedBy.email': userEmail, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        ]),
      ]);

      const chatMessages = chatRes?.count ?? 0;
      const commandsRun  = cmdRes?.count  ?? 0;

      const daily = {};
      for (const d of escsByDay)      daily[d._id] = (daily[d._id] ?? 0) + d.count;
      for (const d of approvalsByDay) daily[d._id] = (daily[d._id] ?? 0) + d.count;

      res.json({ escalationsHandled, escalationsFixed, approvalsDecided, chatMessages, commandsRun, daily });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/profile', requireAuth, async (req, res) => {
    try {
      const { name, password, currentPassword, otp } = req.body;
      const upd = {};
      if (name?.trim()) upd.name = name.trim();

      if (password?.trim()) {
        // Password change requires verification via current password OR email OTP
        if (!currentPassword && !otp)
          return res.status(400).json({ error: 'Provide your current password or an email verification code to change your password' });

        if (currentPassword) {
          const dbUser = await User.findById(req.user.id);
          if (!dbUser || dbUser.password !== currentPassword)
            return res.status(400).json({ error: 'Current password is incorrect' });
        } else {
          const stored = otpStore.get(req.user.id);
          if (!stored || Date.now() > stored.expiresAt || stored.otp !== String(otp))
            return res.status(400).json({ error: 'Invalid or expired verification code' });
          otpStore.delete(req.user.id);
        }
        upd.password = password;
      }

      if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
      const u = await User.findByIdAndUpdate(req.user.id, upd, { new: true, runValidators: true }).select('-password');
      if (!u) return res.status(404).json({ error: 'User not found' });
      // Keep in-memory auth token in sync so req.user.name is current on subsequent requests
      if (upd.name) authService.updateUserPayload(req.user.id, { name: u.name });
      res.json({ id: u._id, email: u.email, name: u.name, role: u.role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full activity list for the current user (escalations handled + approvals decided)
  app.get('/api/profile/activity', requireAuth, async (req, res) => {
    try {
      const userId    = req.user.id;
      const userEmail = req.user.email;
      const [escalations, approvals] = await Promise.all([
        EscalationHistory.find({
          $or: [{ 'acknowledgedBy.userId': userId }, { 'assignedTo.userId': userId }],
        }).sort({ escalatedAt: -1 }).limit(50).lean(),
        ApprovalHistory.find({ 'decidedBy.email': userEmail })
          .sort({ createdAt: -1 }).limit(50).lean(),
      ]);
      res.json({ escalations, approvals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: view any user's full profile + stats + activity
  app.get('/api/users/:id/profile', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id))
        return res.status(400).json({ error: 'Invalid user id' });
      const targetUser = await User.findById(req.params.id).select('-password').lean();
      if (!targetUser) return res.status(404).json({ error: 'User not found' });

      const userId    = targetUser._id.toString();
      const userEmail = targetUser.email;
      const since     = new Date(); since.setDate(since.getDate() - 30);

      const [
        escalationsHandled,
        escalationsFixed,
        approvalsDecided,
        [chatRes],
        [cmdRes],
        escalations,
        approvals,
        escsByDay,
        approvalsByDay,
      ] = await Promise.all([
        EscalationHistory.countDocuments({ 'acknowledgedBy.userId': userId }),
        EscalationHistory.countDocuments({ 'stateUpdatedBy.email': userEmail, status: 'fixed' }),
        ApprovalHistory.countDocuments({ 'decidedBy.email': userEmail }),
        ChatHistory.aggregate([
          { $match: { userId } },
          { $project: { count: { $size: { $filter: { input: { $ifNull: ['$messages', []] }, cond: { $eq: ['$$this.role', 'user'] } } } } } },
        ]),
        CommandHistory.aggregate([
          { $match: { userId } },
          { $project: { count: { $size: { $ifNull: ['$turns', []] } } } },
        ]),
        EscalationHistory.find({
          $or: [{ 'acknowledgedBy.userId': userId }, { 'assignedTo.userId': userId }],
        }).sort({ escalatedAt: -1 }).limit(50).lean(),
        ApprovalHistory.find({ 'decidedBy.email': userEmail })
          .sort({ createdAt: -1 }).limit(50).lean(),
        EscalationHistory.aggregate([
          { $match: { 'acknowledgedBy.userId': userId, acknowledgedAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$acknowledgedAt' } }, count: { $sum: 1 } } },
        ]),
        ApprovalHistory.aggregate([
          { $match: { 'decidedBy.email': userEmail, createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        ]),
      ]);

      const chatMessages = chatRes?.count ?? 0;
      const commandsRun  = cmdRes?.count  ?? 0;

      const daily = {};
      for (const d of escsByDay)      daily[d._id] = (daily[d._id] ?? 0) + d.count;
      for (const d of approvalsByDay) daily[d._id] = (daily[d._id] ?? 0) + d.count;

      res.json({
        user: targetUser,
        stats: { escalationsHandled, escalationsFixed, approvalsDecided, chatMessages, commandsRun, daily },
        activity: { escalations, approvals },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Kubernetes context discovery ────────────────────────────────────────────
  app.get('/api/kube/contexts', requireAuth, async (_req, res) => {
    try {
      const namesRaw  = await kubectl.runCommand('kubectl config get-contexts -o name');
      const names     = namesRaw.split('\n').map(s => s.trim()).filter(Boolean);

      let currentCtx = '';
      try { currentCtx = (await kubectl.runCommand('kubectl config current-context')).trim(); } catch {}

      let monitored = [];
      try { monitored = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
      const monitoredMap = Object.fromEntries(monitored.map(c => [c.context, c]));

      res.json({
        contexts: names.map(n => ({
          name:        n,
          isCurrent:   n === currentCtx,
          isMonitored: !!monitoredMap[n],
          config:      monitoredMap[n] ?? null,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update monitored clusters config (admin only) ────────────────────────
  app.put('/api/kube/clusters', requireAuth, requireAdmin, async (req, res) => {
    const { clusters } = req.body;
    if (!Array.isArray(clusters))
      return res.status(400).json({ error: 'clusters must be an array' });

    const TIERS = new Set(['dev', 'staging', 'production']);
    for (const c of clusters) {
      if (!c.name?.trim() || !c.context?.trim())
        return res.status(400).json({ error: 'each cluster requires name and context' });
      if (!TIERS.has(c.tier ?? 'dev'))
        return res.status(400).json({ error: `invalid tier: ${c.tier}` });
    }

    const content = yaml.dump({
      clusters: clusters.map(c => ({
        name:       c.name.trim(),
        context:    c.context.trim(),
        tier:       c.tier ?? 'dev',
        namespaces: ['*'],
      })),
    });

    try {
      fs.writeFileSync(CONFIG_PATH, content, 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(port, () => console.log(`[API] Dashboard server on http://localhost:${port}`));
}

module.exports = { createServer };
