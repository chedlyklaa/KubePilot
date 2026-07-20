'use strict';
const express = require('express');
const llm = require('../llmClient');
const kubectl = require('../../tools/kubectl');
const chatService = require('../../services/chatService');
const permissionService = require('../../services/permissionService');
const { runInterpret } = require('../../services/interpretGraph');
const { User, CommandHistory } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, loadPerms } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const PolicyEngine = require('../../policy/policyEngine');

const router = express.Router();
const policyEngine = new PolicyEngine();

// A command with no --context is only safe to run if the caller is unrestricted
// (full wildcard admin) — otherwise we can't tell which cluster it targets, so the
// scope check below can't be evaluated and must deny rather than skip.
function hasUnrestrictedAccess(permissions) {
  return (permissions ?? []).some(p => p.cluster === '*' && p.namespace === '*' && p.role === 'admin');
}

// ── Command history (per-user, persisted in MongoDB) ─────────────────────
router.get('/api/command/history', requireAuth, asyncHandler(async (req, res) => {
  const doc = await CommandHistory.findOne({ userId: req.user.id });
  res.json({ turns: doc?.turns ?? [] });
}));

router.put('/api/command/history', requireAuth, asyncHandler(async (req, res) => {
  const { turns } = req.body;
  if (!Array.isArray(turns)) return res.status(400).json({ error: 'turns array required' });
  await CommandHistory.findOneAndUpdate(
    { userId: req.user.id },
    { turns: turns.slice(-50) },   // cap at 50 turns per user
    { upsert: true }
  );
  res.json({ ok: true });
}));

router.delete('/api/command/history', requireAuth, asyncHandler(async (req, res) => {
  await CommandHistory.findOneAndUpdate({ userId: req.user.id }, { turns: [] });
  res.json({ ok: true });
}));

// ── Manual command orders (Orders chat panel) ────────────────────────────────
//
// Routing:
//   pendingRequest == null  →  raw string  →  LLM1 (intent extraction)
//   pendingRequest != null  →  JSON object →  LLM2 (parameter merging)
//
// Both LLMs use the same model; their CRAFT+CoT system prompts differ.
// Retry (up to 3 attempts) on JSON parse / Zod validation failures.
// ─────────────────────────────────────────────────────────────────────────
router.post('/api/command/interpret', requireAuth, loadPerms, asyncHandler(async (req, res) => {
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
  const clusters = getClusters();
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
  try { clusterState = await chatService.buildClusterContext(scopedClusters); } catch (_e) {}

  // ── Two-LLM chain via interpretGraph ─────────────────────────────────
  let result;
  try {
    result = await runInterpret({ order, pendingRequest, clusterList, clusterState, conversationHistory, clusters: scopedClusters, scopeBlock });
    console.log('result from interpretGraph:', result);
  } catch (err) {
    console.error('[INTERPRET] Fatal error after retries:', err.message);
    throw err;
  }

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
}));

// ── Command error diagnosis ───────────────────────────────────────────────
router.post('/api/command/diagnose', requireAuth, asyncHandler(async (req, res) => {
  const { order, command, error } = req.body;
  if (!order?.trim() || !error?.trim())
    return res.status(400).json({ error: 'order and error are required' });

  const clusters = getClusters();

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
}));

router.post('/api/command/execute', requireAuth, loadPerms, async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });

  // Sanitizer gate — same check the autonomous agent path applies before every
  // direct runCommand() call (PolicyEngine.sanitizeCommand): blocks shell metachars,
  // --force deletes, missing namespaces, and invalid resource names.
  const { safe, command: sanitized, reason } = policyEngine.sanitizeCommand(command);
  if (!safe) {
    return res.status(400).json({ success: false, error: `Command blocked by policy: ${reason}` });
  }

  // Permission gate — parse the command and check against user's scope. A command
  // with no --context can't be scope-checked, so it must be denied rather than
  // silently skipped, unless the caller has unrestricted (wildcard admin) access.
  const cmdScope = permissionService.parseCommandScope(sanitized);
  if (!cmdScope.cluster) {
    if (!hasUnrestrictedAccess(req.permissions)) {
      return res.status(403).json({ success: false, error: 'Permission denied: command must target a specific cluster (missing --context=<cluster>)' });
    }
  } else if (!permissionService.checkAccess(req.permissions, cmdScope.cluster, cmdScope.namespace, cmdScope.category)) {
    return res.status(403).json({ success: false, error: `Permission denied: you cannot run ${cmdScope.category} commands on cluster "${cmdScope.cluster}"${cmdScope.namespace ? ` namespace "${cmdScope.namespace}"` : ''}` });
  }

  const impersonateAs = req.user.role === 'admin' ? null : req.user.email;
  console.log(`[CMD] ${req.user.name}${impersonateAs ? ` (--as=${impersonateAs})` : ''} → ${sanitized}`);
  try {
    const output = await kubectl.runCommand(sanitized, { impersonateAs });
    res.json({ success: true, output: output || '(command completed with no output)' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
