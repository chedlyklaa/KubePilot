'use strict';

require('dotenv').config({ override: true });

const { ChatOpenAI }         = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { SystemMessage }      = require('@langchain/core/messages');
const { z }                  = require('zod');
const kubectl                = require('../tools/kubectl');
const { loadConfig }         = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// Zod output schema — shared by both LLM1 and LLM2
// ─────────────────────────────────────────────────────────────────────────────
const CompleteSchema = z.object({
  complete:    z.literal(true),
  command:     z.string().min(1),
  action:      z.string(),
  understood:  z.string(),
  category:    z.enum(['read-only', 'rolling-update', 'scaling', 'config-change', 'destructive']),
  risk:        z.enum(['LOW', 'MEDIUM', 'HIGH']),
  riskReason:  z.string(),
  explanation: z.string(),
  missingFields: z.null(),
  request:       z.null(),
  question:      z.null(),
});

const IncompleteSchema = z.object({
  complete:      z.literal(false),
  command:       z.null(),
  action:        z.string().nullable(),
  understood:    z.null().optional(),
  category:      z.null().optional(),
  risk:          z.null().optional(),
  riskReason:    z.null().optional(),
  explanation:   z.null().optional(),
  missingFields: z.array(z.string()).min(1),
  request:       z.record(z.unknown()),
  question:      z.string().min(1),
});

const InterpretOutputSchema = z.discriminatedUnion('complete', [
  CompleteSchema,
  IncompleteSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared LLM instance factory
// Both LLM1 and LLM2 use the same model — only the system prompt differs.
// maxRetries: 0 because we handle retries ourselves via withRetry().
// ─────────────────────────────────────────────────────────────────────────────
function makeLLM() {
  const config = loadConfig();
  return new ChatOpenAI({
    model:       config.OPENAI_MODEL,
    apiKey:      config.OPENAI_API_KEY,
    configuration: { baseURL: config.OPENAI_BASE_URL },
    temperature: 0.1,
    maxRetries:  0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry helper (replaces p-retry — avoids ESM-only constraint of p-retry v4+)
// Retries only on JSON parse errors and Zod validation failures.
// ─────────────────────────────────────────────────────────────────────────────
async function withRetry(fn, { retries = 3, label = 'LLM' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (attempt > 1) console.warn(`[${label}] Retry ${attempt - 1}/${retries} after: ${lastErr?.message}`);
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      console.warn(`[${label}] Attempt ${attempt} failed — ${err.constructor.name}: ${err.message}`);
      if (attempt === retries + 1) break;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse raw LLM string → validated object
// Strips markdown fences, extracts JSON block, validates against Zod schema.
// ─────────────────────────────────────────────────────────────────────────────
function parseAndValidate(raw, label) {
  const stripped = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const jsonStr  = stripped.match(/\{[\s\S]*\}/)?.[0] ?? stripped;
  const parsed   = JSON.parse(jsonStr);
  // LLM2 accumulates params in `request` throughout the conversation and
  // sometimes keeps it non-null even when complete=true. Force null so
  // CompleteSchema validates correctly (the server doesn't use these fields
  // once a command is ready).
  if (parsed.complete === true) {
    parsed.request       = null;
    parsed.missingFields = null;
    parsed.question      = null;
  }
  return InterpretOutputSchema.parse(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM1 SYSTEM PROMPT
// Audience: raw natural-language string from the operator.
// Technique: CRAFT + Chain-of-Thought + Structured Output + One-Shot.
// ─────────────────────────────────────────────────────────────────────────────
const LLM1_SYSTEM = `\
[CONTEXT]
You are operating inside KubePilot, an autonomous Kubernetes operations platform.
A human operator has just issued a natural language command order.
Your job is to analyse this order and either generate the exact kubectl command or
ask for the information that is missing.

[ROLE]
You are a Senior Kubernetes SRE with 10 + years of hands-on production cluster experience.
You are meticulous, precise, and conservative.
You NEVER fabricate, guess, assume, or silently default any value the operator did not
explicitly state in their order.
Your output is parsed by a machine and executed on a live cluster — there is no tolerance
for hallucinated values.

[ACTION — Chain of Thought — work through these steps in your head before responding]
Step 1 · Read the operator's order carefully.
Step 2 · Identify the Kubernetes operation being requested (action type, e.g. scale_deployment,
         restart_deployment, create_pod, drain_node …).
Step 3 · List every parameter this specific operation REQUIRES to build a valid kubectl command:
         resource name, namespace, replica count, image + tag, node name, port, label, etc.
Step 4 · Go through each required parameter:
         — only mark it as "provided" if the operator explicitly stated it.
         — pronouns ("it", "that pod", "the service"), vague references ("the auth thing"),
           and words like "default" only count if the operator literally said "default namespace".
Step 5 · Decision:
         IF every required parameter is provided AND your confidence is ≥ 0.85
           → generate the kubectl command (Shape A below).
         IF any required parameter is missing OR your confidence is below 0.85 OR intent is ambiguous
           → return null command and list only the missing fields (Shape B below).

[RULES — THESE ARE HARD REJECTION CONDITIONS, NOT GUIDELINES]

NAMESPACE — required for every modifying operation (run, create, delete, scale, restart, set, drain, apply):
  The operator must have literally said "in namespace X", "in the X namespace", "in default", or "-n X".
  If they did not, namespace is MISSING — return Shape B immediately.
  WRONG  → generate kubectl without -n because the operator "probably meant default"
  CORRECT → return Shape B, ask: "Which namespace should this run in?"

IMAGE TAG — required whenever an image is involved (run, set image, create):
  The operator must provide both image name AND tag in the form "name:tag" (e.g., nginx:1.21).
  A bare image name with no colon (e.g., "nginx") means the tag is MISSING — return Shape B.
  WRONG  → use --image=nginx assuming :latest
  CORRECT → return Shape B, ask: "Which tag should be used for the nginx image? (e.g., nginx:1.21)"

REPLICA COUNT — required for scale operations:
  Must be stated as a number. If not, return Shape B.

PORT — required for expose/port-forward operations:
  Must be stated as a number. If not, return Shape B.

RESOURCE NAME — the pod/deployment/service name:
  Take exactly what the operator said. If missing or ambiguous, return Shape B.

CLUSTER:
  Match against the Available Clusters list.
  If only one cluster is configured → use it without asking.
  If multiple clusters exist and the operator did not name one → return Shape B.
  NEVER use a context not found in the Available Clusters list.

INFERENCE ALLOWED (from cluster state only):
  • Single cluster configured → use it without asking.
  • Operator says "the crashing pod" AND cluster state shows exactly one non-Running pod → use that pod name.

[KUBECTL RULES — apply only when generating Shape A]
• Always include --context=<context> from the matching cluster
• ALWAYS include -n <namespace> — this flag is mandatory; a command missing -n will be rejected
• Exactly one kubectl command, no chaining
• NEVER invent flags — use only real kubectl syntax

CORRECT forms:
  kubectl --context=CTX rollout restart deployment/NAME -n NS
  kubectl --context=CTX scale deployment/NAME --replicas=N -n NS
  kubectl --context=CTX delete pod NAME -n NS
  kubectl --context=CTX set image deployment/NAME container=IMAGE:TAG -n NS
  kubectl --context=CTX drain NODE --ignore-daemonsets --delete-emptydir-data
  kubectl --context=CTX get pods -n NS
  kubectl --context=CTX logs POD -n NS --tail=50

SAFETY CLASSIFICATION (required fields for Shape A):
  category: read-only | rolling-update | scaling | config-change | destructive
  risk:     LOW (read-only) | MEDIUM (rolling-update, scaling) | HIGH (config-change, destructive)

[FORMAT — Structured Output]
Return ONLY valid JSON — no markdown, no code fences, no explanation outside the JSON.

Shape A — ALL information present:
{
  "complete":     true,
  "command":      "<full kubectl command>",
  "action":       "<action_key>",
  "understood":   "<plain English summary of the operation>",
  "category":     "<category>",
  "risk":         "<LOW|MEDIUM|HIGH>",
  "riskReason":   "<one sentence explaining the risk level>",
  "explanation":  "<one sentence: what the command does>",
  "missingFields": null,
  "request":      null,
  "question":     null
}

Shape B — information MISSING or confidence < 0.85:
{
  "complete":      false,
  "command":       null,
  "action":        "<action_key or null if intent is unclear>",
  "understood":    null,
  "category":      null,
  "risk":          null,
  "riskReason":    null,
  "explanation":   null,
  "missingFields": ["<field1>", "<field2>"],
  "request":       { "<param>": "<user-provided value, or null if not yet provided>" },
  "question":      "<single focused question asking only for the missing fields>"
}

[ONE-SHOT EXAMPLES]

Example 1 — missing namespace and image tag (common mistake to avoid):
User order: "create a pod named validator in cluster2 with nginx image"

Chain-of-thought (internal):
  Operation: create_pod
  Required:  pod name, image+tag, namespace, cluster
  Provided:  pod name = "validator", cluster = "cluster2", image name = "nginx"
  Missing:   image tag (bare "nginx" has no ":tag"), namespace (operator did not say which namespace)
  Decision:  return Shape B — TWO required fields are missing

Output:
{
  "complete": false,
  "command": null,
  "action": "create_pod",
  "understood": null,
  "category": null,
  "risk": null,
  "riskReason": null,
  "explanation": null,
  "missingFields": ["image_tag", "namespace"],
  "request": { "pod": "validator", "cluster": "cluster2", "image": "nginx", "image_tag": null, "namespace": null },
  "question": "Which nginx image tag should be used (e.g., nginx:1.21), and in which namespace should the pod run?"
}

Example 2 — missing replicas and namespace:
User order: "scale auth-service"

Chain-of-thought (internal):
  Operation: scale_deployment
  Required:  deployment name, replicas, namespace
  Provided:  deployment = "auth-service"
  Missing:   replicas, namespace
  Decision:  return Shape B

Output:
{
  "complete": false,
  "command": null,
  "action": "scale_deployment",
  "understood": null,
  "category": null,
  "risk": null,
  "riskReason": null,
  "explanation": null,
  "missingFields": ["replicas", "namespace"],
  "request": { "deployment": "auth-service", "replicas": null, "namespace": null },
  "question": "What replica count and namespace should auth-service be scaled to?"
}`;

// ─────────────────────────────────────────────────────────────────────────────
// LLM2 SYSTEM PROMPT
// Audience: JSON object with { previousRequest, userAnswer }.
// Technique: CRAFT + Chain-of-Thought + Structured Output + One-Shot.
// ─────────────────────────────────────────────────────────────────────────────
const LLM2_SYSTEM = `\
[CONTEXT]
You are operating inside KubePilot, an autonomous Kubernetes operations platform.
A multi-turn command clarification is in progress.
The operator previously issued an incomplete order.
Missing parameters were identified and the operator was asked about them.
The operator has now provided an additional answer.
Your job is to merge the new answer into the partially-collected request and
re-check whether all required parameters are now present.

[ROLE]
You are a Senior Kubernetes SRE with 10 + years of hands-on production cluster experience.
You are meticulous, precise, and conservative.
You NEVER fabricate, guess, assume, or silently default any value the operator did not
explicitly state.
Your output is parsed by a machine and executed on a live cluster — there is no tolerance
for hallucinated values.

[ACTION — Chain of Thought — work through these steps in your head before responding]
Step 1 · Read the "Previous request" JSON.
         It contains the action type and all parameters collected so far.
         A null value means the parameter has not been provided yet.
Step 2 · Read the operator's new answer.
Step 3 · Map the new answer to the correct field(s) in the request object.
         — Only update fields the operator explicitly answered in this message.
         — Do NOT infer values for fields the operator did not mention.
         — If the answer is ambiguous, treat the field as still missing.
Step 4 · Check whether ALL required parameters for the identified action are now non-null.
Step 5 · Decision:
         IF every required parameter is now provided AND confidence ≥ 0.85
           → generate the kubectl command (Shape A).
         IF any required parameter is still missing OR confidence < 0.85
           → ask for the remaining fields only (Shape B).
           Do NOT re-ask for parameters already collected.

[RULES — THESE ARE HARD REJECTION CONDITIONS, NOT GUIDELINES]

NAMESPACE:
  A namespace is provided only if the operator explicitly said "in namespace X", "in default", or "-n X" in their answer.
  If still null, return Shape B and ask for it.
  WRONG  → set namespace = "default" because it seems implied
  CORRECT → keep namespace: null, return Shape B

IMAGE TAG:
  Image is complete only when operator said "name:tag" (e.g., nginx:1.21).
  A bare name like "nginx" with no colon means tag is still missing — return Shape B.
  WRONG  → accept "nginx" as a complete image reference
  CORRECT → keep image tag null, return Shape B, ask for the tag

REPLICA COUNT:
  Must be a number stated explicitly in the answer. If not, keep null, return Shape B.

RESOURCE NAME:
  Take exactly what the operator said. Never invent or guess a name.

CLUSTER:
  Must be in the Available Clusters list. Never use a context not in that list.

[KUBECTL RULES — apply only when generating Shape A]
• Always include --context=<context> from the matching cluster
• Always include -n <namespace> when namespace was provided
• Exactly one kubectl command, no chaining
• NEVER invent flags — use only real kubectl syntax

SAFETY CLASSIFICATION (required for Shape A):
  category: read-only | rolling-update | scaling | config-change | destructive
  risk:     LOW (read-only) | MEDIUM (rolling-update, scaling) | HIGH (config-change, destructive)

[FORMAT — Structured Output]
Return ONLY valid JSON — no markdown, no code fences, no explanation outside the JSON.
Use the SAME output schema as LLM1:

Shape A — ALL parameters now present:
{
  "complete":     true,
  "command":      "<full kubectl command>",
  "action":       "<action_key>",
  "understood":   "<plain English summary>",
  "category":     "<category>",
  "risk":         "<LOW|MEDIUM|HIGH>",
  "riskReason":   "<one sentence>",
  "explanation":  "<one sentence>",
  "missingFields": null,
  "request":      null,
  "question":     null
}

Shape B — parameters still missing:
{
  "complete":      false,
  "command":       null,
  "action":        "<action_key>",
  "understood":    null,
  "category":      null,
  "risk":          null,
  "riskReason":    null,
  "explanation":   null,
  "missingFields": ["<still-missing-field>"],
  "request":       { "<param>": "<updated value or null if still missing>" },
  "question":      "<focused question asking ONLY for the remaining missing fields>"
}

[ONE-SHOT EXAMPLE]
Previous request:
{
  "action": "scale_deployment",
  "deployment": "auth-service",
  "replicas": null,
  "namespace": null
}
User answer: "3 replicas"

Chain-of-thought (internal):
  Answer maps to: replicas = 3
  Still missing:  namespace
  Decision:       return Shape B, do not re-ask for deployment or replicas

Output:
{
  "complete": false,
  "command": null,
  "action": "scale_deployment",
  "understood": null,
  "category": null,
  "risk": null,
  "riskReason": null,
  "explanation": null,
  "missingFields": ["namespace"],
  "request": { "deployment": "auth-service", "replicas": 3, "namespace": null },
  "question": "Which namespace should auth-service be scaled in?"
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Live resource context — fetched BEFORE the LLM runs
// Extracts resource identifiers from the order + pendingRequest,
// runs targeted kubectl commands, returns a formatted text block.
// ─────────────────────────────────────────────────────────────────────────────

function extractIds(order, pendingRequest) {
  const pr = pendingRequest ?? {};
  const o  = order ?? '';

  const podM  = /\bpod(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o)
             ?? /\b([a-z0-9][a-z0-9\-]+)\s+pod\b/i.exec(o);
  const depM  = /\b(?:deployment|deploy)(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o)
             ?? /\b([a-z0-9][a-z0-9\-]+)\s+(?:deployment|deploy)\b/i.exec(o);
  const stsM  = /\b(?:statefulset|sts)(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o);
  const dsM   = /\b(?:daemonset|ds)(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o);
  const svcM  = /\b(?:service|svc)(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o);
  const cmM   = /\b(?:configmap|cm)(?:\s+named?)?\s+([a-z0-9][a-z0-9\-]*)/i.exec(o);
  const nodeM = /\bnode\s+([a-z0-9][a-z0-9\-\.]*)/i.exec(o);
  const nsM   = /\b(?:namespace|ns)\s+([a-z0-9][a-z0-9\-]*)/i.exec(o)
             ?? /\bin\s+(?:the\s+)?([a-z0-9][a-z0-9\-]+)(?:\s+namespace)?\b/i.exec(o);

  return {
    pod:         pr.pod        ?? pr.podName    ?? podM?.[1]  ?? null,
    deployment:  pr.deployment ?? pr.deploy     ?? depM?.[1]  ?? null,
    statefulset: pr.statefulset                 ?? stsM?.[1]  ?? null,
    daemonset:   pr.daemonset                   ?? dsM?.[1]   ?? null,
    service:     pr.service    ?? pr.svc        ?? svcM?.[1]  ?? null,
    configmap:   pr.configmap  ?? pr.cm         ?? cmM?.[1]   ?? null,
    node:        pr.node                        ?? nodeM?.[1] ?? null,
    namespace:   pr.namespace  ?? pr.ns         ?? nsM?.[1]   ?? null,
    cluster:     pr.cluster    ?? pr.clusterName ?? null,
  };
}

function _fmtPod(pod, clusterName) {
  const meta = pod.metadata ?? {};
  const spec = pod.spec     ?? {};
  const st   = pod.status   ?? {};
  const out  = [`\nPOD ${meta.namespace}/${meta.name} [cluster: ${clusterName}]`];
  out.push(`  phase=${st.phase ?? '?'}  node=${spec.nodeName ?? '?'}`);
  for (const c of (spec.containers ?? [])) {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits   ?? {};
    out.push(`  container: ${c.name}  image: ${c.image}`);
    out.push(`    memory: request=${req.memory ?? 'NOT SET'}  limit=${lim.memory ?? 'NOT SET'}`);
    out.push(`    cpu:    request=${req.cpu    ?? 'NOT SET'}  limit=${lim.cpu    ?? 'NOT SET'}`);
    if (c.ports?.length) out.push(`    ports: ${c.ports.map(p => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ')}`);
    if (c.env?.length)   out.push(`    env: ${c.env.map(e => e.name).join(', ')}`);
  }
  const cs = st.containerStatuses ?? [];
  const restarts = cs.reduce((s, c) => s + (c.restartCount ?? 0), 0);
  out.push(`  total restarts: ${restarts}`);
  const reasons = cs.map(c => c.state?.waiting?.reason ?? c.state?.terminated?.reason).filter(Boolean);
  if (reasons.length) out.push(`  reasons: ${reasons.join(', ')}`);
  return out.join('\n');
}

function _fmtDeployment(dep, clusterName) {
  const meta = dep.metadata ?? {};
  const spec = dep.spec     ?? {};
  const st   = dep.status   ?? {};
  const out  = [`\nDEPLOYMENT ${meta.namespace}/${meta.name} [cluster: ${clusterName}]`];
  out.push(`  replicas: desired=${spec.replicas ?? '?'}  ready=${st.readyReplicas ?? 0}  available=${st.availableReplicas ?? 0}`);
  out.push(`  strategy: ${spec.strategy?.type ?? '?'}`);
  for (const c of (spec.template?.spec?.containers ?? [])) {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits   ?? {};
    out.push(`  container: ${c.name}  image: ${c.image}`);
    out.push(`    memory: request=${req.memory ?? 'NOT SET'}  limit=${lim.memory ?? 'NOT SET'}`);
    out.push(`    cpu:    request=${req.cpu    ?? 'NOT SET'}  limit=${lim.cpu    ?? 'NOT SET'}`);
  }
  return out.join('\n');
}

function _fmtService(svc, clusterName) {
  const meta = svc.metadata ?? {};
  const spec = svc.spec     ?? {};
  const out  = [`\nSERVICE ${meta.namespace}/${meta.name} [cluster: ${clusterName}]`];
  out.push(`  type=${spec.type ?? '?'}  clusterIP=${spec.clusterIP ?? '?'}`);
  if (spec.ports?.length) out.push(`  ports: ${spec.ports.map(p => `${p.port}→${p.targetPort}/${p.protocol ?? 'TCP'}`).join(', ')}`);
  if (spec.selector && Object.keys(spec.selector).length) out.push(`  selector: ${JSON.stringify(spec.selector)}`);
  return out.join('\n');
}

function _fmtNode(node, clusterName) {
  const meta  = node.metadata ?? {};
  const st    = node.status   ?? {};
  const cap   = st.capacity   ?? {};
  const alloc = st.allocatable ?? {};
  const out   = [`\nNODE ${meta.name} [cluster: ${clusterName}]`];
  out.push(`  capacity:    cpu=${cap.cpu ?? '?'}  memory=${cap.memory ?? '?'}  pods=${cap.pods ?? '?'}`);
  out.push(`  allocatable: cpu=${alloc.cpu ?? '?'}  memory=${alloc.memory ?? '?'}  pods=${alloc.pods ?? '?'}`);
  const bad = (st.conditions ?? []).filter(c => c.type === 'Ready' && c.status !== 'True');
  if (bad.length) out.push(`  WARNING: ${bad.map(c => c.message).join('; ')}`);
  return out.join('\n');
}

async function fetchResourceContext(order, pendingRequest, clusters) {
  if (!clusters?.length) return '';
  const ids = extractIds(order, pendingRequest);
  if (!ids.pod && !ids.deployment && !ids.statefulset && !ids.daemonset &&
      !ids.service && !ids.node && !ids.configmap && !ids.namespace) return '';

  // Target the specific cluster if named, else all clusters
  let targets = clusters;
  if (ids.cluster) {
    const m = clusters.find(c => c.name === ids.cluster || c.context === ids.cluster);
    if (m) targets = [m];
  }

  const lines = ['[FETCHED LIVE RESOURCE STATE — use this to answer the operator precisely]'];

  for (const cluster of targets) {
    const ctx = cluster.context;
    const ns  = ids.namespace ?? null;

    // ── Pod ─────────────────────────────────────────────────────────────────
    if (ids.pod) {
      try {
        let pod = null;
        if (ns) {
          const raw = await kubectl.runCommand(`kubectl --context=${ctx} get pod ${ids.pod} -n ${ns} -o json`);
          pod = JSON.parse(raw);
        } else {
          // Search across all namespaces — reuse getPods which already does -A
          const all = await kubectl.getPods('*', ctx, true);
          pod = (all.items ?? []).find(p => p.metadata?.name === ids.pod) ?? null;
        }
        lines.push(pod ? _fmtPod(pod, cluster.name) : `\n  pod "${ids.pod}" not found in cluster ${cluster.name}`);
      } catch (_e) { lines.push(`\n  (pod "${ids.pod}" fetch error: ${_e.message})`); }
    }

    // ── Deployment ──────────────────────────────────────────────────────────
    if (ids.deployment) {
      try {
        const nsFlag = ns ? `-n ${ns}` : '--all-namespaces';
        const raw = await kubectl.runCommand(`kubectl --context=${ctx} get deployment ${ids.deployment} ${nsFlag} -o json`);
        lines.push(_fmtDeployment(JSON.parse(raw), cluster.name));
      } catch (_e) { lines.push(`\n  (deployment "${ids.deployment}" fetch error: ${_e.message})`); }
    }

    // ── StatefulSet ─────────────────────────────────────────────────────────
    if (ids.statefulset) {
      try {
        const nsFlag = ns ? `-n ${ns}` : '--all-namespaces';
        const raw = await kubectl.runCommand(`kubectl --context=${ctx} get statefulset ${ids.statefulset} ${nsFlag} -o json`);
        const sts  = JSON.parse(raw);
        const meta = sts.metadata ?? {};
        const spec = sts.spec     ?? {};
        const st   = sts.status   ?? {};
        const out  = [`\nSTATEFULSET ${meta.namespace}/${meta.name} [cluster: ${cluster.name}]`];
        out.push(`  replicas: desired=${spec.replicas ?? '?'}  ready=${st.readyReplicas ?? 0}`);
        for (const c of (spec.template?.spec?.containers ?? [])) {
          const req = c.resources?.requests ?? {};
          const lim = c.resources?.limits   ?? {};
          out.push(`  container: ${c.name}  image: ${c.image}`);
          out.push(`    memory: request=${req.memory ?? 'NOT SET'}  limit=${lim.memory ?? 'NOT SET'}`);
          out.push(`    cpu:    request=${req.cpu    ?? 'NOT SET'}  limit=${lim.cpu    ?? 'NOT SET'}`);
        }
        lines.push(out.join('\n'));
      } catch (_e) { lines.push(`\n  (statefulset "${ids.statefulset}" fetch error: ${_e.message})`); }
    }

    // ── Service ─────────────────────────────────────────────────────────────
    if (ids.service) {
      try {
        const nsFlag = ns ? `-n ${ns}` : '--all-namespaces';
        const raw = await kubectl.runCommand(`kubectl --context=${ctx} get service ${ids.service} ${nsFlag} -o json`);
        lines.push(_fmtService(JSON.parse(raw), cluster.name));
      } catch (_e) { lines.push(`\n  (service "${ids.service}" fetch error: ${_e.message})`); }
    }

    // ── Node ────────────────────────────────────────────────────────────────
    if (ids.node) {
      try {
        const raw = await kubectl.runCommand(`kubectl --context=${ctx} get node ${ids.node} -o json`);
        lines.push(_fmtNode(JSON.parse(raw), cluster.name));
      } catch (_e) { lines.push(`\n  (node "${ids.node}" fetch error: ${_e.message})`); }
    }

    // ── ConfigMap ───────────────────────────────────────────────────────────
    if (ids.configmap) {
      try {
        const nsFlag = ns ? `-n ${ns}` : '--all-namespaces';
        const raw = await kubectl.runCommand(`kubectl --context=${ctx} get configmap ${ids.configmap} ${nsFlag} -o json`);
        const cm   = JSON.parse(raw);
        const meta = cm.metadata ?? {};
        lines.push(`\nCONFIGMAP ${meta.namespace}/${meta.name} [cluster: ${cluster.name}]`);
        lines.push(`  keys: ${Object.keys(cm.data ?? {}).join(', ') || '(empty)'}`);
      } catch (_e) { lines.push(`\n  (configmap "${ids.configmap}" fetch error: ${_e.message})`); }
    }

    // ── Namespace quota (only when no specific resource was named) ───────────
    if (ids.namespace && !ids.pod && !ids.deployment && !ids.statefulset && !ids.service) {
      try {
        const raw    = await kubectl.runCommand(`kubectl --context=${ctx} get resourcequota -n ${ids.namespace} -o json`);
        const quotas = JSON.parse(raw).items ?? [];
        if (quotas.length) {
          lines.push(`\nNAMESPACE ${ids.namespace} [cluster: ${cluster.name}]`);
          for (const q of quotas) {
            lines.push(`  ResourceQuota: ${q.metadata?.name}`);
            for (const [k, hard] of Object.entries(q.status?.hard ?? {})) {
              lines.push(`    ${k}: used=${q.status?.used?.[k] ?? '?'} / limit=${hard}`);
            }
          }
        }
      } catch {} // namespace may have no quotas — fine
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM1 — handles raw string input
// ─────────────────────────────────────────────────────────────────────────────
async function runLLM1(order, clusterList, clusterState, attempt) {
  const label = 'LLM1';
  console.log(`[${label}] Invoking (attempt ${attempt}) — order: "${order.slice(0, 120)}"`);
  const t0 = Date.now();

  const prompt = ChatPromptTemplate.fromMessages([
    new SystemMessage(LLM1_SYSTEM),
    ['human', 'Available clusters:\n{clusterList}\n\nLive cluster state:\n{clusterState}\n\nUser order: "{order}"'],
  ]);

  const chain = prompt.pipe(makeLLM()).pipe(new StringOutputParser());
  const raw   = await chain.invoke({ clusterList, clusterState, order });

  console.log(`[${label}] Raw response (${Date.now() - t0}ms, ${raw.length} chars): ${raw.slice(0, 300).replace(/\n/g, ' ')}…`);

  const result = parseAndValidate(raw, label);
  console.log(`[${label}] Parsed — complete: ${result.complete}, action: ${result.action ?? 'unknown'}${result.complete ? ', risk: ' + result.risk : ', missing: [' + (result.missingFields ?? []).join(', ') + ']'}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM2 — handles JSON input (partial request + new user answer)
// ─────────────────────────────────────────────────────────────────────────────
async function runLLM2(pendingRequest, userAnswer, clusterList, clusterState, conversationHistory, attempt) {
  const label = 'LLM2';
  console.log(`[${label}] Invoking (attempt ${attempt}) — action: ${pendingRequest.action ?? 'unknown'}, answer: "${String(userAnswer).slice(0, 120)}"`);
  const t0 = Date.now();

  const historyText = conversationHistory.length > 0
    ? conversationHistory.map((h, i) =>
        `Turn ${i + 1}:\n  User: "${h.userMessage}"\n  Question asked: "${h.question ?? '(none)'}"`
      ).join('\n')
    : '(first follow-up — no prior turns)';

  const prompt = ChatPromptTemplate.fromMessages([
    new SystemMessage(LLM2_SYSTEM),
    ['human', 'Available clusters:\n{clusterList}\n\nLive cluster state:\n{clusterState}\n\nConversation history:\n{historyText}\n\nAccumulated request so far:\n{previousRequest}\n\nLatest user answer: "{userAnswer}"'],
  ]);

  const chain = prompt.pipe(makeLLM()).pipe(new StringOutputParser());
  const raw   = await chain.invoke({
    clusterList,
    clusterState,
    historyText,
    previousRequest: JSON.stringify(pendingRequest, null, 2),
    userAnswer,
  });

  console.log(`[${label}] Raw response (${Date.now() - t0}ms, ${raw.length} chars): ${raw.slice(0, 300).replace(/\n/g, ' ')}…`);

  const result = parseAndValidate(raw, label);
  console.log(`[${label}] Parsed — complete: ${result.complete}, action: ${result.action ?? 'unknown'}${result.complete ? ', risk: ' + result.risk : ', missing: [' + (result.missingFields ?? []).join(', ') + ']'}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
//
// Routing rule (determined server-side — frontend does not choose):
//   pendingRequest == null  →  string input  →  LLM1
//   pendingRequest != null  →  JSON input    →  LLM2
//
// Retry: up to 3 attempts on JSON parse errors or Zod validation failures.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Kubernetes documentation via kubectl explain
// Maps order keywords → specific field paths, runs explain, returns text.
// Uses only one cluster (target or first) since schema is cluster-version-specific.
// ─────────────────────────────────────────────────────────────────────────────

const EXPLAIN_MAP = [
  { re: /\b(memory|cpu|resources?|limit|request|Mi|Gi|Ki|millicores?)\b/i,
    paths: ['pod.spec.containers.resources'] },
  { re: /\b(env(?:ironment)?|variable)\b/i,
    paths: ['pod.spec.containers.env'] },
  { re: /\b(port|expose)\b/i,
    paths: ['service.spec.ports'] },
  { re: /\b(replica(?:s)?|scale)\b/i,
    paths: ['deployment.spec.replicas'] },
  { re: /\b(volume|pvc|pv|storage|mount)\b/i,
    paths: ['pod.spec.volumes'] },
  { re: /\b(probe|liveness|readiness|startup)\b/i,
    paths: ['pod.spec.containers.livenessProbe'] },
  { re: /\b(affinity|tolerat|taint|nodeSelector)\b/i,
    paths: ['pod.spec.affinity'] },
  { re: /\b(configmap|cm)\b/i,
    paths: ['pod.spec.volumes.configMap'] },
  { re: /\b(serviceaccount|rbac|role)\b/i,
    paths: ['pod.spec.serviceAccountName'] },
];

const RESOURCE_BASE_EXPLAIN = {
  pod:         'pod.spec',
  deployment:  'deployment.spec',
  statefulset: 'statefulset.spec',
  daemonset:   'daemonset.spec',
  service:     'service.spec',
  node:        'node.status',
  configmap:   'configmap',
};

async function fetchKubeExplain(order, ids, clusters) {
  if (!clusters?.length) return '';
  const cluster = ids.cluster
    ? (clusters.find(c => c.name === ids.cluster || c.context === ids.cluster) ?? clusters[0])
    : clusters[0];
  const ctx = cluster?.context;
  if (!ctx) return '';

  const pathsToRun = new Set();

  for (const [key, path] of Object.entries(RESOURCE_BASE_EXPLAIN)) {
    if (ids[key]) pathsToRun.add(path);
  }
  for (const { re, paths } of EXPLAIN_MAP) {
    if (re.test(order)) for (const p of paths) pathsToRun.add(p);
  }

  if (pathsToRun.size === 0) return '';

  const lines = ['[KUBERNETES API DOCUMENTATION — kubectl explain]'];
  for (const path of [...pathsToRun].slice(0, 4)) {
    try {
      const raw = await kubectl.runCommand(`kubectl explain ${path} --context=${ctx}`, { timeoutMs: 8000 });
      lines.push(`\n--- kubectl explain ${path} ---`);
      lines.push(raw.slice(0, 1200));
    } catch (_e) { /* path may not exist in this k8s version — skip */ }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

async function runInterpret({ order, pendingRequest, clusterList, clusterState = '', conversationHistory = [], clusters = [], scopeBlock = '' }) {
  // Fetch live kubectl data for any resource the operator identified (pod, deployment, service, node…)
  // This runs BEFORE either LLM so both LLM1 and LLM2 see the actual current state of the resource.
  let resourceContext = '';
  try {
    resourceContext = await fetchResourceContext(order, pendingRequest, clusters);
    if (resourceContext) console.log('[INTERPRET] Resource context fetched:\n', resourceContext.slice(0, 400));
  } catch (_e) {
    console.warn('[INTERPRET] fetchResourceContext failed:', _e.message);
  }

  // Fetch k8s API docs via kubectl explain for fields/operations mentioned in the order
  let docsContext = '';
  try {
    const ids = extractIds(order, pendingRequest);
    docsContext = await fetchKubeExplain(order, ids, clusters);
    if (docsContext) console.log('[INTERPRET] K8s docs fetched:', docsContext.match(/explain \S+/g)?.join(', '));
  } catch (_e) {
    console.warn('[INTERPRET] fetchKubeExplain failed:', _e.message);
  }

  const enrichedState = clusterState
    + (resourceContext ? '\n\n' + resourceContext : '')
    + (docsContext     ? '\n\n' + docsContext     : '')
    + (scopeBlock      ? '\n\n[USER PERMISSION SCOPE]\n' + scopeBlock : '');

  const isJson = pendingRequest != null;
  const label  = isJson ? 'LLM2' : 'LLM1';
  return withRetry(
    attempt => isJson
      ? runLLM2(pendingRequest, order, clusterList, enrichedState, conversationHistory, attempt)
      : runLLM1(order, clusterList, enrichedState, attempt),
    { retries: 3, label },
  );
}

module.exports = { runInterpret };
