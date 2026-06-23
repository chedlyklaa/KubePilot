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
const silenceStore        = require('./silenceStore');
const notificationStore   = require('./notificationStore');
const authService         = require('./authService');
const mongoose = require('mongoose');
const { User, Group, ApprovalHistory, EscalationHistory, ChatHistory, CommandHistory, RbacAuditLog, AuditEvent } = require('../db/models');
const audit = require('../audit/logger');

const metricsCollector       = require('../monitoring/metricsCollector');
const { PrometheusClient }   = require('../monitoring/prometheusClient');
const capacityForecastEngine = require('../agents/capacityForecastEngine');
const { runInterpret } = require('../services/interpretGraph');

// Per-cluster Prometheus client cache — reused across requests so we don't re-probe on every call
const _podClusterClients = new Map();
function _getPodClient(name, url) {
  if (!_podClusterClients.has(name)) _podClusterClients.set(name, new PrometheusClient(url));
  return _podClusterClients.get(name);
}

// ── Service layer ─────────────────────────────────────────────────────────────
const userService        = require('../services/userService');
const profileService     = require('../services/profileService');
const permissionService  = require('../services/permissionService');
const rbacSync           = require('../services/rbacSync');
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
async function loadPerms(req, res, next) {
  if (req.user?.role === 'admin') {
    req.permissions = [{ cluster: '*', namespace: '*', role: 'admin' }];
    return next();
  }
  try { req.permissions = await permissionService.loadPermissions(req.user.id); }
  catch (_e) { req.permissions = []; }
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
// When scopedClusters is provided, only those clusters are included (permission-scoped).
async function buildClusterContext(scopedClusters) {
  const lines = [`LIVE CLUSTER SNAPSHOT — ${new Date().toUTCString()}`];

  // ── Pods across all configured clusters ────────────────────────────────────
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

        // Only output non-healthy pods to keep LLM context manageable
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
  const DASHBOARD_ORIGIN = process.env.DASHBOARD_URL || 'http://localhost:5173';
  app.use(cors({ origin: DASHBOARD_ORIGIN, credentials: true }));
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

  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      await authService.forgotPassword(req.body.email || '');
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    try {
      await authService.resetPassword(token, password);
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

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
    const { overrideReasons, preferredAction, adminNote } = req.body ?? {};
    res.json({ success: await approvalStore.deny(req.params.id, req.user, { overrideReasons, preferredAction, adminNote }) });
  });
  app.post('/api/approvals/:id/silence', requireAuth, requireAdmin, async (req, res) => {
    res.json({ success: await approvalStore.silence(req.params.id, req.user) });
  });

  // ── Silences ──────────────────────────────────────────────────────────────
  app.get('/api/silences', requireAuth, requireAdmin, (_req, res) => {
    res.json(silenceStore.getAll());
  });

  app.post('/api/silences', requireAuth, requireAdmin, async (req, res) => {
    const { key, durationMs, reason } = req.body ?? {};
    if (!key || !durationMs) return res.status(400).json({ error: 'key and durationMs are required' });
    const entry = await silenceStore.add(key, Number(durationMs), reason ?? '', {
      name: req.user.name, email: req.user.email, role: req.user.role,
    });
    res.json(entry);
  });

  app.delete('/api/silences/:id', requireAuth, requireAdmin, async (req, res) => {
    const ok = await silenceStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Silence not found' });
    res.json({ success: true });
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

  // ── Groups (team-based permissions) ───────────────────────────────────────
  app.get('/api/groups', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await Group.find().sort({ name: 1 }).lean()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/groups', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, description, permissions, members } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
      const g = await Group.create({ name: name.trim(), description, permissions: permissions ?? [] });
      if (Array.isArray(members) && members.length) {
        await User.updateMany({ _id: { $in: members } }, { group: g._id });
        // Sync new members to K8s
        for (const uid of members) {
          try { await rbacSync.syncUserToK8s(uid); } catch {}
        }
      }
      res.status(201).json(g);
    } catch (err) {
      const status = err.code === 11000 ? 409 : 500;
      res.status(status).json({ error: err.code === 11000 ? 'Group name already exists' : err.message });
    }
  });
  app.put('/api/groups/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, description, permissions, members } = req.body;
      const upd = {};
      if (name !== undefined)        upd.name = name.trim();
      if (description !== undefined) upd.description = description;
      if (permissions !== undefined)  upd.permissions = permissions;
      const g = await Group.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true });
      if (!g) return res.status(404).json({ error: 'Group not found' });
      // Update membership: unlink old members not in the new list, link new ones
      if (Array.isArray(members)) {
        const oldMembers = await User.find({ group: req.params.id }).select('_id').lean();
        const oldIds = oldMembers.map(u => u._id.toString());
        const removed = oldIds.filter(id => !members.includes(id));
        const added   = members.filter(id => !oldIds.includes(id));
        if (removed.length) await User.updateMany({ _id: { $in: removed } }, { $unset: { group: '' } });
        if (added.length)   await User.updateMany({ _id: { $in: added } }, { group: g._id });
        // Re-sync changed users to K8s
        for (const uid of [...removed, ...added]) {
          try { await rbacSync.syncUserToK8s(uid); } catch {}
        }
      }
      // When permissions changed, sync all current members to K8s
      if (permissions !== undefined) {
        try { await rbacSync.syncGroupToK8s(req.params.id); }
        catch (err) { console.warn('[RBAC Sync] group sync failed:', err.message); }
      }
      res.json(g);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/groups/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      // Collect members before unlinking so we can re-sync them (removes group bindings)
      const members = await User.find({ group: req.params.id }).select('_id role').lean();
      await User.updateMany({ group: req.params.id }, { $unset: { group: '' } });
      await Group.findByIdAndDelete(req.params.id);
      // Re-sync each ex-member — their effective perms no longer include the group's scopes
      for (const m of members) {
        if (m.role !== 'admin') {
          try { await rbacSync.syncUserToK8s(m._id); } catch {}
        }
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── User permissions + group assignment ───────────────────────────────────
  app.get('/api/users/:id/permissions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = await User.findById(req.params.id).select('permissions group').populate('group').lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      const effective = await permissionService.loadPermissions(req.params.id);
      res.json({ own: user.permissions ?? [], group: user.group ?? null, effective });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.put('/api/users/:id/permissions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { permissions, group } = req.body;
      const upd = {};
      if (permissions !== undefined) upd.permissions = permissions;
      if (group !== undefined) upd.group = group || null;
      const user = await User.findByIdAndUpdate(req.params.id, upd, { new: true, runValidators: true }).select('-password');
      if (!user) return res.status(404).json({ error: 'User not found' });
      // Sync to real K8s RBAC in the background — don't block the response
      let k8sSync = null;
      if (user.role !== 'admin') {
        try { k8sSync = await rbacSync.syncUserToK8s(req.params.id); }
        catch (err) { console.warn('[RBAC Sync] user sync failed:', err.message); }
      }
      res.json({ ...user.toObject?.() ?? user, k8sSync });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Effective permissions for the current user (any role) ─────────────────
  app.get('/api/auth/permissions', requireAuth, loadPerms, (req, res) => {
    res.json({ permissions: req.permissions });
  });

  // ── Cluster pod health ────────────────────────────────────────────────────
  app.get('/api/cluster/pods', requireAuth, async (_req, res) => {
    try { res.json(await clusterService.getPodHealth(CONFIG_PATH)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Chat config (returns LLM model info — API key stays server-side) ──────
  app.get('/api/chat/config', requireAuth, (_req, res) => {
    res.json({
      model:   process.env.OPENAI_MODEL   || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
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

  // ── Chat — cluster context snapshot (read-only, scoped to user permissions) ─
  app.get('/api/chat/cluster-context', requireAuth, loadPerms, async (req, res) => {
    try {
      let clusters = [];
      try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
      const scoped = permissionService.filterClusters(req.permissions, clusters);
      const text = await buildClusterContext(scoped);
      res.json({ text, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chat tools (read-only cluster introspection) ───────────────────────────
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

  function _resolveContext(clusterName) {
    try {
      const clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
      if (clusterName) {
        const c = clusters.find(c => c.name === clusterName || c.context === clusterName);
        if (c) return c.context;
      }
      return clusters[0]?.context ?? 'minikube';
    } catch { return 'minikube'; }
  }

  async function _execTool(name, args) {
    const ns  = args.namespace ?? 'default';
    const ctx = _resolveContext(args.cluster);
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

  const MAX_TOOL_ROUNDS = 5;

  // ── Chat — streaming (SSE) with tool use ──────────────────────────────────
  app.post('/api/chat/stream', requireAuth, async (req, res) => {
    const { messages, apiKey, baseURL, model, withClusterContext } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    const client = (apiKey || baseURL)
      ? new (require('openai'))({ apiKey: apiKey || process.env.OPENAI_API_KEY, baseURL: baseURL || process.env.OPENAI_BASE_URL })
      : llm;

    const systemPrompt = withClusterContext
      ? `You are KubePilot AI, embedded inside the KubePilot Kubernetes management dashboard. You have READ-ONLY access to the user's live Kubernetes clusters through tools.

RULES:
- Use the provided tools to fetch live data — do NOT guess or make up pod names, metrics, or statuses.
- Call tools proactively when the user asks about pods, logs, events, node health, metrics, or deployments.
- You can call multiple tools to gather evidence before responding.
- Reference specific pod names, namespaces, phases, restart counts from the tool results.
- You are read-only: diagnose and analyze only. For write operations, tell the user to use the Orders tab.
- Be concise. Lead with the key finding, then the explanation.
- When asked for a report or overview, call list_pods and get_node_status first to get current state.
- For Prometheus queries, use standard PromQL: container_memory_working_set_bytes, container_cpu_usage_seconds_total, kube_pod_container_status_restarts_total, etc.`
      : CHAT_SYSTEM_PROMPT;

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
        if (useTools && round < MAX_TOOL_ROUNDS) createParams.tools = CHAT_TOOLS;

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

        if (toolCalls.length === 0) {
          break;
        }

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

          const result = await _execTool(tc.name, parsedArgs);
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
      const all = doc?.messages || [];
      const limit = parseInt(req.query.limit, 10);
      const before = parseInt(req.query.before, 10);
      if (limit > 0) {
        const end = before >= 0 ? before : all.length;
        const start = Math.max(0, end - limit);
        return res.json({ messages: all.slice(start, end), total: all.length, hasMore: start > 0 });
      }
      res.json({ messages: all, total: all.length, hasMore: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/chat/history', requireAuth, async (req, res) => {
    try {
      const { messages } = req.body;
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
      const doc = await ChatHistory.findOneAndUpdate(
        { userId: req.user.id },
        { $push: { messages: { $each: messages } } },
        { upsert: true, new: true }
      );
      res.json({ ok: true, total: doc.messages.length });
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
  //
  // Routing:
  //   pendingRequest == null  →  raw string  →  LLM1 (intent extraction)
  //   pendingRequest != null  →  JSON object →  LLM2 (parameter merging)
  //
  // Both LLMs use the same model; their CRAFT+CoT system prompts differ.
  // Retry (up to 3 attempts) on JSON parse / Zod validation failures.
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/command/interpret', requireAuth, loadPerms, async (req, res) => {
    const { order, pendingRequest = null, conversationHistory = [] } = req.body;
    if (!order?.trim()) return res.status(400).json({ error: 'order is required' });

    // ── Cluster provisioning — intercept before LLM (fresh turns only) ───────
    if (!pendingRequest) {
      const PROVISION_RE = /\b(create|start|provision|spin\s*up|add|new)\s+(cluster|minikube)\s+(?:named?\s+)?([a-z0-9][a-z0-9\-]*)/i;
      const pm = PROVISION_RE.exec(order.trim());
      if (pm) {
        // Check provision permission before proceeding
        if (req.user.role !== 'admin') {
          const u = await User.findById(req.user.id).select('canProvision').lean();
          if (!u?.canProvision) {
            return res.json({
              type: 'clarification',
              question: 'You don\'t have permission to create clusters. Ask your admin to enable cluster provisioning for your account.',
              missingFields: ['permission'], request: null, action: null,
            });
          }
        }
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
    }

    // ── Build cluster context — scoped to user's permissions ────────────────
    let clusters = [];
    try { clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
    const scopedClusters = permissionService.filterClusters(req.permissions, clusters);

    // Early denial: if the user mentions a real cluster/namespace they can't access, tell them directly
    if (req.user.role !== 'admin') {
      const allClusterNames = clusters.map(c => c.name);
      const scopedNames     = new Set(scopedClusters.map(c => c.name));
      const orderLower      = order.toLowerCase();
      const deniedCluster   = allClusterNames.find(n => orderLower.includes(n.toLowerCase()) && !scopedNames.has(n));
      if (deniedCluster) {
        return res.json({
          type: 'clarification',
          question: `You don't have permission to access cluster "${deniedCluster}". Your allowed clusters: ${scopedNames.size > 0 ? [...scopedNames].join(', ') : 'none'}. Contact your admin to get access.`,
          missingFields: ['permission'], request: null, action: null,
        });
      }
      // Check namespace: if a specific namespace is mentioned and the user has cluster access but not that namespace
      const nsMatch = order.match(/\b(?:namespace|ns|-n)\s+([a-z0-9][a-z0-9-]*)/i) ?? order.match(/\bin\s+(?:the\s+)?([a-z0-9][a-z0-9-]+)(?:\s+namespace)/i);
      if (nsMatch) {
        const mentionedNs = nsMatch[1];
        const targetCluster = [...scopedNames][0]; // best guess if only one
        if (targetCluster && !permissionService.checkAccess(req.permissions, targetCluster, mentionedNs, 'read-only')) {
          return res.json({
            type: 'clarification',
            question: `You don't have permission to access namespace "${mentionedNs}"${targetCluster ? ` on cluster "${targetCluster}"` : ''}. Contact your admin to get access.`,
            missingFields: ['permission'], request: null, action: null,
          });
        }
      }
    }

    const clusterList = scopedClusters.length
      ? scopedClusters.map(c =>
          `- ${c.name} (context: ${c.context}, tier: ${c.tier ?? 'dev'}, namespaces: ${(c.namespaces ?? ['default']).join(', ')})`
        ).join('\n')
      : '(no clusters configured yet)';

    // User scope block injected into LLM context
    const scopeBlock = permissionService.describeScope(req.permissions);

    // Live pod/node state scoped to the user's permitted clusters
    let clusterState = '(cluster state unavailable)';
    try { clusterState = await buildClusterContext(scopedClusters); } catch (_e) {}

    try {
      // ── Two-LLM chain via interpretGraph ─────────────────────────────────
      const result = await runInterpret({ order, pendingRequest, clusterList, clusterState, conversationHistory, clusters: scopedClusters, scopeBlock });
      console.log('result from interpretGraph:', result);
      if (result.complete) {
        // Post-LLM hard check: verify the generated command is within scope
        // Use the LLM's category (authoritative) but extract cluster/ns from the actual command
        const cmdScope = permissionService.parseCommandScope(result.command);
        const category = result.category || cmdScope.category;
        if (cmdScope.cluster && !permissionService.checkAccess(req.permissions, cmdScope.cluster, cmdScope.namespace, category)) {
          return res.json({
            type:     'clarification',
            question: `You don't have permission to run ${category} commands on cluster "${cmdScope.cluster}"${cmdScope.namespace ? ` namespace "${cmdScope.namespace}"` : ''}. Contact your admin for access.`,
            missingFields: ['permission'],
            request:  null,
            action:   result.action ?? null,
          });
        }
        return res.json({
          type:        'command',
          command:     result.command,
          action:      result.action,
          understood:  result.understood,
          category:    result.category,
          risk:        result.risk,
          riskReason:  result.riskReason,
          explanation: result.explanation,
        });
      }

      // ── Clarification needed — return question + accumulated request ───────
      return res.json({
        type:          'clarification',
        question:      result.question,
        missingFields: result.missingFields,
        request:       result.request,
        action:        result.action ?? null,
      });

    } catch (err) {
      console.error('[INTERPRET] Fatal error after retries:', err.message);
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

  // ── RBAC Management ───────────────────────────────────────────────────────

  function isDangerous(roleName) {
    return ['cluster-admin', 'admin', 'edit'].includes(roleName) ||
      roleName.includes('cluster-admin');
  }

  // Fix 2 — context allow-list: load monitored contexts from clusters.yaml once per call.
  // All RBAC endpoints call requireMonitoredContext() before touching kubectl.
  function getMonitoredContexts() {
    try {
      const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return new Set((cfg.clusters ?? []).map(c => c.context));
    } catch { return new Set(); }
  }
  function requireMonitoredContext(context, res) {
    if (!getMonitoredContexts().has(context)) {
      res.status(403).json({ error: 'Context not in monitored clusters' });
      return false;
    }
    return true;
  }

  // GET /api/rbac/namespaces?context=CTX
  app.get('/api/rbac/namespaces', requireAuth, async (req, res) => {
    const { context } = req.query;
    if (!context) return res.status(400).json({ error: 'context required' });
    if (!requireMonitoredContext(context, res)) return;                        // Fix 2
    try {
      res.json(await kubectl.getNamespaces(context));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/rbac/overview?context=CTX&namespace=NS[&includeSystem=true]
  // namespace=_all fetches across all namespaces (client filters)
  app.get('/api/rbac/overview', requireAuth, async (req, res) => {
    const { context, namespace = '_all', includeSystem } = req.query;
    if (!context) return res.status(400).json({ error: 'context required' });
    if (!requireMonitoredContext(context, res)) return;                            // Fix 2
    const ns = namespace === '_all' ? '*' : namespace;
    try {
      const [roles, clusterRoles, roleBindings, clusterRoleBindings, serviceAccounts] =
        await Promise.all([
          kubectl.getRoles(ns, context),
          kubectl.getClusterRoles(context),
          kubectl.getRoleBindings(ns, context),
          kubectl.getClusterRoleBindings(context),
          kubectl.getServiceAccounts(ns, context),
        ]);
      // Annotate bindings with server-computed dangerous flag so the client
      // doesn't need its own copy of the isDangerous logic.
      const markDangerous = arr => arr.map(b => ({ ...b, dangerous: isDangerous(b.roleRef?.name ?? '') }));
      // Fix 5 — strip system: ClusterRoles server-side; bypass with ?includeSystem=true
      const filteredClusterRoles = includeSystem === 'true'
        ? clusterRoles
        : clusterRoles.filter(r => !r.metadata.name.startsWith('system:'));
      res.json({
        roles, clusterRoles: filteredClusterRoles, serviceAccounts,
        roleBindings:        markDangerous(roleBindings),
        clusterRoleBindings: markDangerous(clusterRoleBindings),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/rbac/audit?context=CTX&namespace=NS — flattened subject→role mapping
  app.get('/api/rbac/audit', requireAuth, async (req, res) => {
    const { context, namespace = '_all' } = req.query;
    if (!context) return res.status(400).json({ error: 'context required' });
    if (!requireMonitoredContext(context, res)) return;                           // Fix 2
    const ns = namespace === '_all' ? '*' : namespace;
    try {
      const [roleBindings, clusterRoleBindings] = await Promise.all([
        kubectl.getRoleBindings(ns, context),
        kubectl.getClusterRoleBindings(context),
      ]);
      const entries = [];
      for (const rb of roleBindings) {
        for (const subject of rb.subjects ?? []) {
          entries.push({
            subject:   subject.name,
            kind:      subject.kind,
            namespace: rb.metadata.namespace,
            role:      rb.roleRef.name,
            roleKind:  rb.roleRef.kind,
            scope:     'namespace',
            dangerous: isDangerous(rb.roleRef.name),
          });
        }
      }
      for (const crb of clusterRoleBindings) {
        for (const subject of crb.subjects ?? []) {
          entries.push({
            subject:   subject.name,
            kind:      subject.kind,
            namespace: subject.namespace ?? '*',
            role:      crb.roleRef.name,
            roleKind:  crb.roleRef.kind,
            scope:     'cluster',
            dangerous: isDangerous(crb.roleRef.name),
          });
        }
      }
      res.json(entries);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const RBAC_APPLY_KINDS = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ServiceAccount']);

  // POST /api/rbac/apply — apply one or more YAML documents (admin only)
  app.post('/api/rbac/apply', requireAuth, requireAdmin, async (req, res) => {
    const { yaml: yamlContent, context } = req.body;
    if (!yamlContent || !context)
      return res.status(400).json({ error: 'yaml and context required' });
    if (!requireMonitoredContext(context, res)) return;

    // Parse every document in the multi-doc YAML (--- separated)
    let docs;
    try {
      docs = yaml.loadAll(yamlContent).filter(d => d != null);
    } catch (e) {
      return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
    }
    if (docs.length === 0)
      return res.status(400).json({ error: 'No documents found in YAML' });

    // Validate every document against the RBAC allowlist before touching the cluster
    for (const doc of docs) {
      const kind = doc?.kind;
      if (!kind || !RBAC_APPLY_KINDS.has(kind))
        return res.status(400).json({
          error: `Only RBAC resources are permitted. Got kind: ${kind ?? '(none)'}`,
          invalidDocument: { kind, name: doc?.metadata?.name },
        });
    }

    // Dry-run all documents together (same file = one kubectl call)
    let dryRunOutput;
    try {
      dryRunOutput = await kubectl.dryRunManifest(yamlContent, context);
    } catch (err) {
      return res.status(400).json({ error: 'Dry-run failed', detail: err.message });
    }

    // Apply all documents together
    let output;
    try {
      output = await kubectl.applyManifest(yamlContent, context);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // Audit-log every document that was applied — fire-and-forget
    for (const doc of docs) {
      RbacAuditLog.create({
        userId: req.user.id, userEmail: req.user.email,
        action: 'apply',
        kind: doc?.kind, name: doc?.metadata?.name, namespace: doc?.metadata?.namespace,
        context, yaml: yamlContent, timestamp: new Date(),
      }).catch(e => console.error('[RBAC Audit]', e.message));
    }

    res.json({ output, dryRunOutput, appliedCount: docs.length });
  });

  // DELETE /api/rbac/resource — delete a RBAC resource (admin only)
  app.delete('/api/rbac/resource', requireAuth, requireAdmin, async (req, res) => {
    const { kind, name, namespace, context } = req.body;
    if (!kind || !name || !context)
      return res.status(400).json({ error: 'kind, name, context required' });
    if (!requireMonitoredContext(context, res)) return;                           // Fix 2
    try {
      const output = await kubectl.deleteRbacResource(kind, name, namespace, context);
      // Fix 3 — fire-and-forget audit log
      RbacAuditLog.create({ userId: req.user.id, userEmail: req.user.email, action: 'delete', kind, name, namespace, context, timestamp: new Date() }).catch(e => console.error('[RBAC Audit]', e.message));
      res.json({ output });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Cluster provisioning (admin or users with canProvision flag) ────────────
  app.post('/api/cluster/provision/start', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
      const u = await User.findById(req.user.id).select('canProvision').lean();
      if (!u?.canProvision) return res.status(403).json({ error: 'You don\'t have permission to create clusters. Ask your admin to enable it.' });
    }
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

  app.post('/api/command/execute', requireAuth, loadPerms, async (req, res) => {
    const { command } = req.body;
    if (!command?.trim()) return res.status(400).json({ error: 'command is required' });

    // Permission gate — parse the command and check against user's scope
    const cmdScope = permissionService.parseCommandScope(command);
    if (cmdScope.cluster && !permissionService.checkAccess(req.permissions, cmdScope.cluster, cmdScope.namespace, cmdScope.category)) {
      return res.status(403).json({ success: false, error: `Permission denied: you cannot run ${cmdScope.category} commands on cluster "${cmdScope.cluster}"${cmdScope.namespace ? ` namespace "${cmdScope.namespace}"` : ''}` });
    }

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

  // GET /api/metrics/pods — all-pods Prometheus metrics across all configured clusters
  app.get('/api/metrics/pods', requireAuth, async (_req, res) => {
    try {
      const clusterCfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
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
        const client = _getPodClient(name, url);
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

  // ── Capacity Forecasting ─────────────────────────────────────────────────

  // GET /api/capacity/forecast?cluster=NAME
  // Returns latest cached forecast for a cluster, or computes a fresh one.
  app.get('/api/capacity/forecast', requireAuth, async (req, res) => {
    try {
      const cluster = req.query.cluster || null;
      if (!cluster) return res.status(400).json({ error: 'cluster query param required' });

      if (process.env.CAPACITY_FORECAST_ENABLED !== 'true')
        return res.json({ enabled: false, forecast: null });

      const forecast = await capacityForecastEngine.getForecast(cluster);
      res.json({ enabled: true, cluster, forecast: forecast ?? null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/capacity/history?cluster=NAME&target=node:node-1&hours=48
  // Returns raw MetricSnapshot timeseries for sparkline rendering.
  app.get('/api/capacity/history', requireAuth, async (req, res) => {
    try {
      const { cluster, target, hours } = req.query;
      if (!cluster || !target) return res.status(400).json({ error: 'cluster and target query params required' });

      if (process.env.CAPACITY_FORECAST_ENABLED !== 'true')
        return res.json({ enabled: false, snapshots: [] });

      const snapshots = await capacityForecastEngine.getHistory({
        cluster,
        target,
        hours: Math.min(720, parseInt(hours ?? '48', 10)),
      });
      res.json({ enabled: true, cluster, target, snapshots });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Capacity overview (aggregated pods + nodes + forecast + cost) ────────
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

  // Azure Managed Disk pricing ($/Gi/month by storage class)
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

  // Azure Load Balancer pricing
  const AZURE_LB_BASE_MONTHLY = 18.25;
  const AZURE_LB_RULE_MONTHLY = 7.30;
  const AZURE_LB_FREE_RULES   = 5;

  // Azure network egress pricing ($/Gi)
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

  app.get('/api/capacity/overview', requireAuth, async (req, res) => {
    const clusterName = req.query.cluster;
    if (!clusterName) return res.status(400).json({ error: 'cluster required' });
    try {
      let allClusters = [];
      try { allClusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? []; } catch {}
      const cluster = allClusters.find(c => c.name === clusterName);
      if (!cluster) return res.status(404).json({ error: 'cluster not found' });
      const ctx = cluster.context;

      // Pods
      const podHealth = await clusterService.getPodHealth(CONFIG_PATH);
      const clusterData = podHealth.clusters?.find(c => c.name === clusterName) ?? { pods: [] };
      const pods = clusterData.pods ?? [];

      // Nodes
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
                         : memNum; // bare number = bytes
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

      // Forecast — save a live snapshot and compute on the fly
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

      // Pod-based cost: sum all container resource requests to size the workload
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

      // Totals
      const totalCpu   = nodes.reduce((s, n) => s + n.cpuCores, 0);
      const totalMemGi = nodes.reduce((s, n) => s + n.memGi, 0);
      const avgCpuPct  = nodes.length ? Math.round(nodes.reduce((s, n) => s + (n.cpuPct ?? 0), 0) / nodes.length) : 0;
      const avgMemPct  = nodes.length ? Math.round(nodes.reduce((s, n) => s + (n.memPct ?? 0), 0) / nodes.length) : 0;

      const running  = pods.filter(p => p.phase === 'Running' && p.isReady).length;
      const failing  = pods.filter(p => p.phase !== 'Running' || !p.isReady || p.restarts >= 5).length;

      // Per-node provisioned cost (what the infra costs)
      const provisionedAzure = nodes.reduce((s, n) => s + n.azureMonthly, 0);

      // ── Disk cost (PersistentVolumes) ───────────────────────────────
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

      // ── Load Balancer cost ──────────────────────────────────────────
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

      // ── Network egress cost (from Prometheus) ──────────────────────
      let egressMonthly = 0;
      let egressDetails = [];
      try {
        const promUrl = cluster.prometheusUrl || process.env.PROMETHEUS_URL;
        if (promUrl) {
          const promClient = _getPodClient(clusterName, promUrl);
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

      res.json({
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
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // ── Agent Management (admin only) ──────────────────────────────────────────
  app.get('/api/agents', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const clusters = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
      const agents = [
        { id: 'planner',       name: 'Planner Agent',              description: 'Analyzes pod issues and plans remediation actions', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
        { id: 'guardian',      name: 'Guardian Agent',             description: 'Validates action safety before execution (risk, policy, tier)', model: process.env.GUARDIAN_MODEL || process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
        { id: 'reflection',    name: 'Reflection Agent',           description: 'Learns from outcomes and generates rules for future cycles', model: process.env.GUARDIAN_MODEL || process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
        { id: 'investigator',  name: 'Investigator Agent',         description: 'Deep-dives into escalated issues with logs and metrics', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
        { id: 'pod-analyzer',  name: 'Pod Analyzer',               description: 'Detects unhealthy pods and classifies failure reasons', model: null, enabled: true, type: 'analyzer' },
        { id: 'node-analyzer', name: 'Node Analyzer',              description: 'Monitors node conditions, pressure, and flapping', model: null, enabled: true, type: 'analyzer' },
        { id: 'event-analyzer',name: 'Event Analyzer',             description: 'Parses Kubernetes warning events for anomalies', model: null, enabled: true, type: 'analyzer' },
        { id: 'correlation',   name: 'Change Correlation Engine',  description: 'Correlates recent deployments with failures', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'engine' },
        { id: 'capacity',      name: 'Capacity Forecast Engine',   description: 'Predicts resource exhaustion via regression', model: null, enabled: process.env.CAPACITY_FORECAST_ENABLED === 'true', type: 'engine' },
      ];
      const config = {
        cycleIntervalMs:  parseInt(process.env.CYCLE_INTERVAL_MS || '30000', 10),
        llmModel:         process.env.OPENAI_MODEL || '',
        guardianModel:    process.env.GUARDIAN_MODEL || '',
        prometheusUrl:    process.env.PROMETHEUS_URL || 'http://localhost:9090',
        prometheusAvailable: metricsCollector.isAvailable(),
        vectorStoreReady:    require('../memory/vectorStore').ready,
      };
      res.json({ agents, clusters, config });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/agents/config', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { key, value } = req.body;
      const ALLOWED = ['CYCLE_INTERVAL_MS', 'CAPACITY_FORECAST_ENABLED', 'OPENAI_MODEL', 'GUARDIAN_MODEL'];
      if (!ALLOWED.includes(key)) return res.status(400).json({ error: `Cannot update ${key}` });
      process.env[key] = String(value);
      res.json({ ok: true, key, value: String(value) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Learned Rules (admin only) ────────────────────────────────────────────────
  const { LearnedRule } = require('../db/models');

  app.get('/api/agents/rules', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const rules = await LearnedRule.find().sort({ updatedAt: -1 }).lean();
      res.json(rules);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/agents/rules/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { active } = req.body;
      const rule = await LearnedRule.findByIdAndUpdate(req.params.id, { active }, { new: true });
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      res.json(rule);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/agents/rules/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const rule = await LearnedRule.findByIdAndDelete(req.params.id);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // ── Audit log endpoint ────────────────────────────────────────────────────
  app.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit   = Math.min(500, parseInt(req.query.limit  ?? '200', 10));
      const cluster = req.query.cluster  || null;
      const status  = req.query.status   || null;
      const agent   = req.query.agent    || null;
      const docs    = await audit.getLogsMongo({ limit, cluster, status, agent });
      res.json({ docs });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.listen(port, () => console.log(`[API] Dashboard server on http://localhost:${port}`));
}

module.exports = { createServer };
