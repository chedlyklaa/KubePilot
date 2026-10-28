#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT     = Number(process.env.MOCK_LLM_PORT ?? 4010);
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS ?? 1500);
const EMBED_DIM = Number(process.env.EMBEDDING_VECTOR_SIZE ?? 768);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[MOCK-LLM ${new Date().toLocaleTimeString()}]`, ...a);

// Get plain text from message content
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p.text ?? '').join('') : '');
const systemText = msgs => msgs.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n');
const firstUser = msgs => textOf(msgs.find(m => m.role === 'user')?.content);
const toolNames = body => (body.tools ?? []).map(t => t.function?.name).filter(Boolean);
const tryJson = s => { try { return JSON.parse(s); } catch { return null; } };

// Pair previous tool calls with their results
function toolHistory(msgs) {
  const results = new Map(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, textOf(m.content)]));
  const out = [];
  for (const m of msgs) {
    for (const tc of m.tool_calls ?? []) {
      const args = tryJson(tc.function?.arguments) ?? {};
      out.push({ name: tc.function?.name, args, result: results.get(tc.id) ?? '' });
    }
  }
  return out;
}

function findLine(text, re) {
  return (text ?? '').split('\n').map(l => l.trim()).find(l => re.test(l)) ?? null;
}

// Mock orchestrator response
function orchestrator(msgs) {
  const signals = tryJson(firstUser(msgs)) ?? {};
  const incidents = (signals.pods ?? []).map(p => {
    const bad = (p.containers ?? []).find(c => c.waitingReason || c.terminatedReason || (c.exitCode ?? 0) !== 0) ?? p.containers?.[0] ?? {};
    const deployment = p.controllerRef?.startsWith('deployment/') ? p.controllerRef.split('/')[1] : null;
    const type = bad.waitingReason || bad.terminatedReason || (p.phase !== 'Running' ? `Pod${p.phase}` : 'ContainerError');
    return {
      scope: 'pod',
      type,
      severity: 'high',
      clusterName: p.clusterName,
      namespace: p.namespace,
      podName: p.name,
      deployment,
      exitCode: bad.exitCode ?? null,
      oomKilled: bad.terminatedReason === 'OOMKilled',
      restartCount: bad.restartCount ?? 0,
      evidenceSummary: `Pod ${p.namespace}/${p.name}: container "${bad.name}" is ${type}` +
        `${bad.exitCode != null ? ` (last exit code ${bad.exitCode})` : ''} after ${bad.restartCount ?? 0} restart(s).`,
      correlationTag: null,
      complexity: 'COMPLEX',
      blastScope: null,
    };
  });
  log(`ORCHESTRATOR → ${incidents.length} incident(s)${incidents.length ? ': ' + incidents.map(i => `${i.namespace}/${i.podName} [${i.type}]`).join(', ') : ''}`);
  return { incidents };
}

// Mock investigator response
function investigator(msgs) {
  const payload = tryJson(firstUser(msgs)) ?? {};
  const issue = payload.issues?.[0] ?? {};
  const cluster = issue.clusterName ?? payload.clusters?.[0];
  const ns = issue.namespace ?? 'default';
  const pod = issue.podName;
  const dep = issue.deployment;
  const history = toolHistory(msgs);
  const ran = history.filter(h => h.name === 'run_readonly_kubectl_command');
  const turn = msgs.filter(m => m.role === 'assistant').length;

  const call = (command, reasoning) => ({ name: 'run_readonly_kubectl_command', args: { clusterName: cluster, command, reasoning } });
  const script = [
    [
      call(`get pods -n ${ns} -o wide`, `Starting from the symptom: ${pod} is reported as ${issue.type}. First confirm the pod's current phase, restart count and node placement, and whether sibling pods are affected.`),
      call(`describe pod ${pod} -n ${ns}`, 'The describe output gives the last terminated state, exit code and recent events — this tells me whether this is a scheduling, image, probe or application-level failure.'),
    ],
    [
      call(`logs ${pod} -n ${ns} --previous --tail=50`, 'The container is restarting, so the PREVIOUS container\'s logs hold the actual crash message — that is where the application says why it exited.'),
    ],
    dep ? [
      call(`get deployment ${dep} -n ${ns} -o yaml`, `The logs point at configuration. Inspect the pod template of deployment/${dep} to see which env vars / ConfigMaps are actually wired in, to confirm the config layer is the root cause rather than the app itself.`),
      call(`get configmap -n ${ns}`, 'Check whether a ConfigMap in the namespace already carries the missing setting (in which case the fix would be wiring it in, not adding a new value).'),
    ] : null,
  ].filter(Boolean);

  if (turn < script.length) {
    log(`INVESTIGATOR turn ${turn + 1} → ${script[turn].map(c => c.args.command).join(' | ')}`);
    return { toolCalls: script[turn] };
  }

  const describe = ran.find(h => h.args.command?.startsWith('describe pod'))?.result ?? '';
  const logs     = ran.find(h => h.args.command?.startsWith('logs'))?.result ?? '';
  const depYaml  = ran.find(h => h.args.command?.startsWith('get deployment'))?.result ?? '';

  const fatalLine  = findLine(logs, /fatal|error|panic|exception|not set|missing/i);
  const exitLine   = findLine(describe, /Exit Code:/);
  const reasonLine = findLine(describe, /Reason:\s+(CrashLoopBackOff|Error|OOMKilled)/);
  const backoffEvt = findLine(describe, /Back-off restarting failed container/i);
  const envVar     = (logs.match(/variable\s+([A-Z][A-Z0-9_]+)/)
                   ?? logs.match(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b[^\n]*\b(?:not set|missing|undefined)/))?.[1] ?? null;
  const envAbsent  = envVar && depYaml && !depYaml.includes(`name: ${envVar}`);
  const commandsRun = ran.map(h => `kubectl ${h.args.command}`);

  const evidence = [
    fatalLine && `Previous container log: "${fatalLine}"`,
    exitLine && `kubectl describe pod ${pod}: ${exitLine}`,
    reasonLine && `kubectl describe pod ${pod}: ${reasonLine}`,
    backoffEvt && `Event: ${backoffEvt.replace(/\s+/g, ' ')}`,
    envAbsent && `deployment/${dep} pod template has no env entry named ${envVar} (checked spec.template.spec.containers[].env)`,
  ].filter(Boolean);
  if (evidence.length === 0) evidence.push(`kubectl describe pod ${pod} shows the container in ${issue.type} with ${issue.restartCount ?? 'several'} restarts`);

  const report = envVar ? {
    rootCause: `Container in ${pod} exits on startup (exit code ${issue.exitCode ?? 1}) because the required environment variable ${envVar} is not defined in the pod template of deployment/${dep}. The application validates its configuration at boot and terminates, so Kubernetes keeps restarting it (CrashLoopBackOff).`,
    layer: 'config',
    symptom: `${pod} in ${issue.type}, ${issue.restartCount ?? 0} restarts`,
    componentsInvolved: [`pod/${pod}`, `deployment/${dep}`, `env:${envVar}`],
    recommendedFocus: `Add the missing ${envVar} environment variable to deployment/${dep} so new pods start with a valid configuration.`,
  } : {
    rootCause: `Container in ${pod} is crashing on startup${fatalLine ? `: "${fatalLine}"` : ''}. The failure is in the application process itself; a fresh rollout is the lowest-risk first remediation.`,
    layer: 'application',
    symptom: `${pod} in ${issue.type}`,
    componentsInvolved: [`pod/${pod}`, dep ? `deployment/${dep}` : null].filter(Boolean),
    recommendedFocus: dep ? `Restart deployment/${dep} and watch the new pod.` : 'Recreate the pod.',
  };

  const result = {
    ...report,
    confidence: envVar ? 0.94 : 0.78,
    evidence,
    riskLevel: 'medium',
    layersInspected: ['pod', 'application', 'controller', 'config', 'node'],
    perLayerFindings: [
      { layer: 'node', status: 'healthy', summary: 'Pod is scheduled and the node reports no pressure conditions — not a node problem.', commandsRun: commandsRun.filter(c => c.includes('-o wide')) },
      { layer: 'pod', status: 'critical', summary: `Container repeatedly terminates${exitLine ? ` (${exitLine})` : ''}; kubelet is backing off restarts.`, commandsRun: commandsRun.filter(c => c.includes('describe')) },
      { layer: 'application', status: 'critical', summary: fatalLine ? `Application aborts at boot: "${fatalLine}"` : 'Application exits during startup.', commandsRun: commandsRun.filter(c => c.includes('logs')) },
      ...(envVar ? [{ layer: 'config', status: 'critical', summary: `${envVar} is required by the app but absent from the Deployment's env and from every ConfigMap in ${ns}.`, commandsRun: commandsRun.filter(c => c.includes('deployment') || c.includes('configmap')) }] : []),
      { layer: 'image', status: 'healthy', summary: 'Image pulled successfully — container starts and runs until the application exits.', commandsRun: commandsRun.filter(c => c.includes('describe')) },
    ],
    evidenceSufficiency: envVar ? 0.92 : 0.8,
    severity: 'high',
    reasoning: envVar
      ? `The crash is deterministic and happens before the app does any work: the previous container log names ${envVar} as missing, the exit code is a clean application exit (not OOM/signal), and the Deployment's pod template confirms ${envVar} is never set. Node, image and scheduling layers are all healthy, so the config layer is the single root cause — further commands would not change this conclusion.`
      : 'Evidence across pod, application and node layers consistently points at the application process; no infrastructure layer shows a fault.',
  };
  log(`INVESTIGATOR submit → ${result.rootCause.slice(0, 110)}...`);
  return { toolCalls: [{ name: 'submit_investigation_report', args: result }] };
}

// Mock planner response
function planner(msgs) {
  const payload = tryJson(firstUser(msgs)) ?? {};
  const issue = payload.issues?.[0] ?? {};
  const cluster = issue.clusterName ?? payload.clusters?.[0];
  const ns = issue.namespace ?? 'default';
  const dep = issue.deployment;
  const rootCause = payload.investigation?.rootCause ?? '';
  const envVar = rootCause.match(/environment variable ([A-Z][A-Z0-9_]+)/)?.[1] ?? null;
  const history = toolHistory(msgs);
  const turn = msgs.filter(m => m.role === 'assistant').length;
  const issueKey = `${ns}/${issue.podName ?? dep}`;

  if (envVar && dep && turn === 0) {
    log(`PLANNER turn 1 → gather_more_evidence: get svc -n ${ns}`);
    return { toolCalls: [{ name: 'gather_more_evidence', args: { clusterName: cluster, command: `get svc -n ${ns}` } }] };
  }

  let step;
  if (envVar && dep) {
    const svcOut = history.find(h => h.name === 'gather_more_evidence')?.result ?? '';
    const svc = svcOut.split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).find(n => n && n !== 'kubernetes');
    const value = /HOST|ADDR|URL/i.test(envVar) && svc ? `${svc}.${ns}.svc.cluster.local` : 'changeme';
    step = {
      action: `set missing ${envVar} on deployment/${dep}`,
      command: `set env deployment/${dep} -n ${ns} ${envVar}=${value}`,
      target: { kind: 'Deployment', name: dep, namespace: ns },
      reason: `Investigation shows the app exits because ${envVar} is unset. ${svc ? `Service "${svc}" exists in ${ns}, so ${envVar} is pointed at its cluster DNS name. ` : ''}Setting it on the Deployment triggers a rolling update with a valid configuration.`,
      risk: 'low',
      reversible: true,
      inverseCommand: `set env deployment/${dep} -n ${ns} ${envVar}-`,
      issueKeys: [issueKey],
    };
  } else if (dep) {
    step = {
      action: `restart deployment/${dep}`,
      command: `rollout restart deployment/${dep} -n ${ns}`,
      target: { kind: 'Deployment', name: dep, namespace: ns },
      reason: 'Roll out fresh pods for the crashing workload.',
      risk: 'low', reversible: true, inverseCommand: null, issueKeys: [issueKey],
    };
  } else {
    step = {
      action: `recreate pod ${issue.podName}`,
      command: `delete pod ${issue.podName} -n ${ns}`,
      target: { kind: 'Pod', name: issue.podName, namespace: ns },
      reason: 'Bare pod with no controller — recreate it.',
      risk: 'medium', reversible: false, inverseCommand: null, issueKeys: [issueKey],
    };
  }

  const dryRunDone = history.some(h => h.name === 'dry_run_step');
  if (!dryRunDone) {
    log(`PLANNER → dry_run_step: ${step.command}`);
    return { toolCalls: [{ name: 'dry_run_step', args: { ...step, clusterName: cluster } }] };
  }
  log(`PLANNER → submit_plan: ${step.command}`);
  return { toolCalls: [{ name: 'submit_plan', args: { steps: [step] } }] };
}

// Mock guardian response
function guardian(msgs) {
  const prompt = firstUser(msgs);
  const command = prompt.match(/^Command:\s+(.*)$/m)?.[1]?.trim() ?? '';
  const rootCause = prompt.match(/^Root cause:\s+(.*)$/m)?.[1]?.trim() ?? '';
  const logLine = findLine(prompt.split('RECENT POD LOGS')[1] ?? '', /fatal|error|not set|missing/i);
  const verdict = {
    verdict: 'APPROVE',
    classification: 'SAFE',
    reason: `The command "${command}" targets the owning Deployment (not the pod), is scoped to a single workload in one namespace, and directly addresses the diagnosed root cause. It is fully reversible via its inverse command and triggers a standard rolling update, so there is no availability risk beyond the already-crashing pod.`,
    suggestedCommand: null,
    confidence: 0.91,
    approvalRequired: false,
    stateDrift: false,
    safetyConcerns: ['Rolling update replaces the pod — acceptable, the current pod is not serving traffic'],
    evidenceCited: [logLine, rootCause.slice(0, 160)].filter(Boolean),
    impactSummary: 'Single Deployment rolled; no other workloads affected.',
    estimatedBlastRadius: 'single_pod',
  };
  log(`GUARDIAN → ${verdict.verdict} (${verdict.classification}) ${command}`);
  return { content: JSON.stringify(verdict) };
}

function rootCauseFit(msgs) {
  log('ROOT-CAUSE-FIT → YES');
  return { fit: 'YES', reason: 'The proposed command changes exactly the configuration the investigation identified as missing — mechanism matches.', evidenceCited: ['root cause names the missing setting', 'command sets that same setting on the owning Deployment'] };
}

function reflection(msgs) {
  const u = firstUser(msgs);
  const envVar = u.match(/environment variable ([A-Z][A-Z0-9_]+)/)?.[1];
  log('REFLEXION → lesson recorded');
  return {
    content: JSON.stringify({
      rootCause: envVar ? `Required environment variable ${envVar} missing from the Deployment pod template.` : 'Application crash on startup.',
      lessonsLearned: envVar
        ? `CrashLoopBackOff with a clean exit code and a "${envVar} not set" log line is a config-layer fault: fix it on the controller's pod template (set env), never by restarting or deleting pods.`
        : 'Inspect previous-container logs first for CrashLoopBackOff.',
      suggestedRule: envVar ? 'IF CrashLoopBackOff AND previous logs report a required env var "not set" THEN set env on the owning Deployment (never restart/delete the pod)' : null,
      confidence: 0.9,
    }),
  };
}

// Mock response for fast path and other calls
function fastPathOrGeneric(body, schema) {
  const props = schema?.properties ?? {};
  if ('requiresDeepInvestigation' in props) {
    return { rootCause: 'Needs full investigation', confidence: 0.3, supportingEvidence: ['insufficient bounded evidence for a fast-path diagnosis'], alternativeHypotheses: [], missingInformation: ['previous container logs'], evidenceSufficient: false, requiresDeepInvestigation: true, severity: 'high', reasoning: 'Escalating to the full Investigator.', layer: 'application' };
  }
  if ('commands' in props) return { commands: [] };
  return fillFromSchema(schema);
}

function fillFromSchema(s) {
  if (!s) return {};
  if (s.anyOf || s.oneOf) return fillFromSchema((s.anyOf ?? s.oneOf).find(x => x.type !== 'null') ?? {});
  const t = Array.isArray(s.type) ? s.type.find(x => x !== 'null') : s.type;
  if (s.enum) return s.enum[0];
  if (t === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fillFromSchema(v)]));
  if (t === 'array') return [];
  if (t === 'number' || t === 'integer') return 0.5;
  if (t === 'boolean') return false;
  return 'n/a';
}

function chatReply(msgs) {
  const q = textOf([...msgs].reverse().find(m => m.role === 'user')?.content).slice(0, 200);
  return { content: `I'm KubePilot running in demo mode. You asked: "${q}". The autonomous pipeline (Orchestrator → Investigator → Planner → Guardian → Executor) is active and watching the cluster — check the Workflows page to follow an incident live.` };
}

// Route a request to the right mock
function route(body) {
  const msgs = body.messages ?? [];
  const sys = systemText(msgs);
  const tools = toolNames(body);
  const rf = body.response_format;
  const schema = rf?.json_schema?.schema
    ?? (body.tool_choice?.function?.name ? body.tools?.find(t => t.function?.name === body.tool_choice.function.name)?.function?.parameters : null);

  let out;
  if (tools.includes('run_readonly_kubectl_command')) out = investigator(msgs);
  else if (tools.includes('submit_plan'))             out = planner(msgs);
  else if (/Orchestrator agent/i.test(sys))           out = orchestrator(msgs);
  else if (/Guardian Agent/i.test(sys))               out = guardian(msgs);
  else if (/Reflection Agent/i.test(sys))             out = reflection(msgs);
  else if (/assessing ONE narrow question/i.test(sys)) out = rootCauseFit(msgs);
  else if (schema)                                    out = fastPathOrGeneric(body, schema);
  else                                                out = chatReply(msgs);

  if (out.toolCalls || out.content != null) return out;
  if (!rf && body.tool_choice?.function?.name) return { toolCalls: [{ name: body.tool_choice.function.name, args: out }] };
  return { content: JSON.stringify(out) };
}

// Build an OpenAI style message
function buildMessage({ content, toolCalls }) {
  const msg = { role: 'assistant', content: toolCalls ? null : content };
  if (toolCalls) {
    msg.tool_calls = toolCalls.map(tc => ({
      id: 'call_' + crypto.randomBytes(8).toString('hex'),
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  return msg;
}

const USAGE = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 };

function sendCompletion(res, body, out) {
  const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'mock';
  const message = buildMessage(out);
  const finish = message.tool_calls ? 'tool_calls' : 'stop';

  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: USAGE }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const chunk = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: '' });
  if (message.tool_calls) {
    chunk({ tool_calls: message.tool_calls.map((tc, index) => ({ index, ...tc })) });
  } else {
    for (const piece of (message.content ?? '').match(/[\s\S]{1,40}/g) ?? []) chunk({ content: piece });
  }
  chunk({}, finish);
  if (body.stream_options?.include_usage) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: USAGE })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

function embedding(text, dim) {
  const v = new Array(dim);
  let seed = crypto.createHash('sha256').update(String(text)).digest();
  for (let i = 0; i < dim; i++) {
    if (i % 32 === 0 && i) seed = crypto.createHash('sha256').update(seed).digest();
    v[i] = (seed[i % 32] / 255) * 2 - 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const url = req.url.replace(/^\/[0-9a-f-]{36}/, '');
    try {
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
      }
      const body = tryJson(raw) ?? {};
      if (url.endsWith('/embeddings')) {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', model: body.model, usage: { prompt_tokens: 10, total_tokens: 10 }, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embedding(t, body.dimensions ?? EMBED_DIM) })) }));
      }
      if (url.endsWith('/chat/completions')) {
        const out = route(body);
        await sleep(DELAY_MS);
        return sendCompletion(res, body, out);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${req.url}` } }));
    } catch (err) {
      log('ERROR', err.stack);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock error: ${err.message}` } }));
    }
  });
});

server.listen(PORT, () => log(`OpenAI-compatible mock listening on http://localhost:${PORT}/v1 (delay ${DELAY_MS}ms/call)`));
