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
const { User, ApprovalHistory, EscalationHistory, ChatHistory } = require('../db/models');

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

  // ── Chat config (returns LLM settings for the UI) ────────────────────────
  app.get('/api/chat/config', requireAuth, (_req, res) => {
    res.json({
      model:   process.env.OPENAI_MODEL   || '',
      baseURL: process.env.OPENAI_BASE_URL || '',
      apiKey:  process.env.OPENAI_API_KEY  || '',
    });
  });

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
          { role: 'system', content: 'You are a helpful Kubernetes and DevOps assistant. Help with K8s issues, cluster management, YAML, and cloud infrastructure.' },
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
          { role: 'system', content: 'You are a helpful Kubernetes and DevOps assistant. Help with K8s issues, cluster management, YAML, and cloud infrastructure.' },
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
