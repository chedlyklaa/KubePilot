'use strict';
require('dotenv').config({ override: true });
const { randomUUID }        = require('crypto');
const { traceable }          = require('langsmith/traceable');
const { ChatOpenAI }         = require('@langchain/openai');
const kubectl                = require('../tools/kubectl');
const { isActiveContainerProblem, RECENT_EVIDENCE_WINDOW_MS } = require('../tools/podHealth');
const shortMemory            = require('../memory/shortMemory');
const escalationStore        = require('../api/escalationStore');
const vectorStore            = require('../memory/vectorStore');
const episodicMemory         = require('../memory/episodicMemory');
const ruleEngine             = require('../memory/ruleEngine');
const metricsCollector       = require('../monitoring/metricsCollector');
const clusterConfigStore     = require('../config/clusterConfig');
const rbacWatcher            = require('../services/rbacWatcher');
const { runBackgroundChecks } = require('./backgroundChecks');
const { loadConfig }         = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { IncidentListSchema } = require('../orchestrator/schemas');
const { runWorkflow }        = require('../orchestrator/graph');
const { issueKey }           = require('../orchestrator/issueKey');
const { IncidentTracer, resourceFromIssue } = require('../monitoring/incidentTracer');

const _config = loadConfig();
const llm = new ChatOpenAI({
  apiKey:  _config.OPENAI_API_KEY,
  model:   _config.OPENAI_MODEL,
  configuration: _config.OPENAI_BASE_URL ? { baseURL: _config.OPENAI_BASE_URL } : undefined,
  temperature: 0,
  maxTokens: 8000,
}).withStructuredOutput(IncidentListSchema, { method: 'functionCalling' });

const SEVERITY_SCORE = { critical: 4, high: 3, medium: 2, low: 1 };
const CORRELATION_PIN_TTL_MS = 30 * 60 * 1000;

const SYSTEM_PROMPT = `You are the Orchestrator agent of an autonomous Kubernetes remediation system.
You receive a compact summary of the current pods, nodes, and warning events for ONE
NAMESPACE — but that namespace may exist in more than one cluster, and you may be shown
evidence from several clusters at once. Every pod/node/event below carries its own
"clusterName" field — do not assume they're all from the same cluster just because they're
in one input. Classify this evidence into a list of distinct INCIDENTS worth investigating —
do not report healthy/normal state.

━━━ WHEN TO MERGE, WHEN TO KEEP SEPARATE ━━━
Merge multiple symptoms into ONE incident ONLY when they belong to the SAME pod/deployment
IN THE SAME CLUSTER (e.g. a CrashLoopBackOff pod plus its own warning events is one incident,
not two). Two different pods are TWO incidents even if the symptom looks identical (e.g. two
unrelated pods both in CrashLoopBackOff are two separate incidents, one per pod/deployment) —
never merge across different pods, deployments, namespaces, or clusters just because the
failure type matches. If the SAME deployment name is broken the SAME way in more than one
cluster (e.g. the same bad image rolled out everywhere), that is still one incident PER
CLUSTER, not one incident spanning clusters — but call out the relationship explicitly in
each incident's evidenceSummary (e.g. "same image tag as the api deployment failing in
cluster X — likely the same bad rollout"), since that connection is exactly what makes this
worth flagging.
Every downstream system (dedup, dispatch grouping, the Investigator) keys off the SPECIFIC
pod/deployment/namespace/node/cluster you name below, not off "type" — an over-merged
incident makes its members invisible to all of that.

━━━ CORRELATION TAG — WHAT ACTUALLY GETS INVESTIGATED TOGETHER ━━━
Being in the same namespace does NOT mean two incidents are related — e.g. kube-system
holds coredns, etcd, kube-apiserver, and kube-proxy, which are usually failing for
completely unrelated reasons even though they share a namespace. Bundling unrelated
incidents into one investigation wastes time investigating things that have nothing to do
with each other. Use "correlationTag" to say what's ACTUALLY related:
  - Two (or more) incidents you believe share a root cause or a cascading relationship
    (e.g. an app crashing BECAUSE its database in the same namespace is down; the same
    bad image rolled out to two apps; a node problem that's the real cause behind several
    pod failures) → give EVERY incident in that relationship the exact same short tag
    string (e.g. "db-outage-cascade", "shared-image-rollout-v2.3"). Case-sensitive exact
    match — this determines which incidents get investigated together, not evidenceSummary
    prose.
  - An incident that stands on its own (true for MOST incidents — do not force a
    connection) → leave "correlationTag" null.
Do not invent a shared tag just to group things together — an honest null is correct far
more often than a guessed relationship.

━━━ REQUIRED IDENTIFYING FIELDS ━━━
For every incident, set "scope" to pod, node, or cluster, "clusterName" to the exact cluster
that incident's evidence came from, and then COPY the exact identifying field(s) verbatim
from the input signal that triggered it — do not leave them null and do not paraphrase them
into evidenceSummary only:
  - scope "pod":  namespace is REQUIRED, and podName or deployment is REQUIRED.
  - scope "node": nodeName is REQUIRED.
  - scope "cluster": use ONLY for issues with no single owning pod/node (e.g. a
    cluster-wide HPA or admission-controller failure). Scope "cluster" is NOT a
    shortcut to skip filling in namespace/podName/nodeName — if your own evidenceSummary
    names a specific pod, deployment, or node, that incident MUST use scope "pod" or
    "node" with that identifier copied into the structured field, never "cluster".
evidenceSummary is a short justification for why you classified it as an incident — it does
NOT substitute for filling in the structured fields above; both are required.

━━━ COMPLEXITY CLASSIFICATION (SIMPLE vs COMPLEX) ━━━
Every pod signal below includes three deterministic fields computed from live cluster state
(NOT your judgment, and not something you need to re-derive): "managedByController" (true if
a ReplicaSet/StatefulSet/DaemonSet owns this pod), "unhealthySiblings" (how many OTHER pods
owned by the SAME controller are currently unhealthy), and "controllerRef" (e.g.
"deployment/api", or null for a bare pod). Use these, plus your own understanding of the
failure, to set every incident's "complexity" field:

Classify complexity as SIMPLE only if ALL of these are true:
- The incident matches a known single-resource pattern: CrashLoopBackOff, OOMKilled,
  ImagePullBackOff / ErrImagePull, Pending/Unschedulable, missing ConfigMap/Secret
  reference, liveness/readiness probe failure.
- Exactly ONE resource is affected — the pod's "unhealthySiblings" is 0.
- The pod is managed by a controller — "managedByController" is true.
- No related/linked incident is active on the same node or workload — if you gave this
  incident a correlationTag shared with another incident, it is NOT simple.

If ANY condition fails, or you are unsure → COMPLEX. When in doubt, always choose COMPLEX —
misrouting to COMPLEX costs time, misrouting to SIMPLE risks a wrong fix. Node-scoped and
cluster-scoped incidents can never be SIMPLE — always classify those COMPLEX.

If nothing is wrong, return an empty incidents array.`;

// Summarize pod state
function _summarizePods(podsJson) {
  const items = (podsJson?.items ?? []).slice(0, 300);
  return items
    .map(p => {
      const statuses = p.status?.containerStatuses ?? [];
      const phase = p.status?.phase;
      const bad = phase === 'Succeeded'
        ? statuses.filter(cs => cs.state?.terminated && cs.state.terminated.exitCode !== 0)
        : statuses.filter(isActiveContainerProblem);
      if ((phase === 'Running' || phase === 'Succeeded') && bad.length === 0) return null;
      return {
        name:      p.metadata?.name,
        namespace: p.metadata?.namespace,
        phase:     p.status?.phase,
        nodeName:  p.spec?.nodeName,
        ownerKind: p.metadata?.ownerReferences?.[0]?.kind ?? null,
        ownerName: p.metadata?.ownerReferences?.[0]?.name ?? null,
        containers: statuses.map(cs => ({
          name:         cs.name,
          ready:        cs.ready,
          restartCount: cs.restartCount,
          waitingReason:    cs.state?.waiting?.reason ?? null,
          terminatedReason: cs.state?.terminated?.reason ?? null,
          exitCode:         cs.state?.terminated?.exitCode ?? cs.lastState?.terminated?.exitCode ?? null,
        })),
      };
    })
    .filter(Boolean);
}

function _summarizeNodes(nodesJson) {
  return (nodesJson?.items ?? []).map(n => ({
    name: n.metadata?.name,
    unschedulable: !!n.spec?.unschedulable,
    conditions: (n.status?.conditions ?? [])
      .filter(c => c.status !== 'False' || c.type === 'Ready')
      .map(c => ({ type: c.type, status: c.status, reason: c.reason })),
    taints: (n.spec?.taints ?? []).map(t => `${t.key}=${t.value ?? ''}:${t.effect}`),
  }));
}

// Check if an event is recent
function _isRecentEvent(e) {
  const lastSeen = e.lastTimestamp ?? e.eventTime;
  if (!lastSeen) return true;
  const ts = new Date(lastSeen).getTime();
  if (Number.isNaN(ts)) return true;
  return (Date.now() - ts) < RECENT_EVIDENCE_WINDOW_MS;
}

function _summarizeEvents(eventsJson) {
  return (eventsJson?.items ?? [])
    .filter(e => e.type === 'Warning' && _isRecentEvent(e))
    .slice(-200)
    .map(e => ({
      reason:    e.reason,
      message:   e.message,
      count:     e.count,
      lastSeen:  e.lastTimestamp ?? e.eventTime,
      involved:  { kind: e.involvedObject?.kind, name: e.involvedObject?.name, namespace: e.involvedObject?.namespace },
    }));
}

// Find incidents that hide other issues in the namespace
function _findScopeGamingIssues(incidents, signals) {
  const knownPods = (signals.pods ?? []).map(p => ({ name: p.name, namespace: p.namespace }));
  const problems = [];
  incidents.forEach((incident, i) => {
    if (incident.scope !== 'cluster') return;
    const text = incident.evidenceSummary ?? '';
    const match = knownPods.find(p => p.name && text.includes(p.name));
    if (match) problems.push({ index: i, podName: match.name, namespace: match.namespace });
  });
  return problems;
}

const POD_SHAPED_TYPE_RE = /\b(pod|container|crashloop|oom|imagepull|errimage|restart|evicted|probe)/i;

function _findMisscopedNodeIncidents(incidents, signals) {
  const single = list => (list.length === 1 ? list[0] : null);
  const maxRestarts = p => Math.max(0, ...(p.containers ?? []).map(c => c.restartCount ?? 0));
  const fixes = [];
  incidents.forEach((incident, i) => {
    if (incident.scope !== 'node') return;
    const podShaped = POD_SHAPED_TYPE_RE.test(incident.type ?? '') || (incident.restartCount ?? 0) > 0 || incident.exitCode != null;
    if (!podShaped) return;

    const node = (signals.nodes ?? []).find(n => n.name === incident.nodeName && n.clusterName === incident.clusterName);
    if (!node) return;
    const nodeHasProblem = node.unschedulable || node.conditions.some(c => (c.type === 'Ready' ? c.status !== 'True' : true));
    if (nodeHasProblem) return;

    const podsOnNode = (signals.pods ?? []).filter(p => p.nodeName === node.name && p.clusterName === incident.clusterName);
    const text = incident.evidenceSummary ?? '';
    const match = podsOnNode.find(p => p.name && text.includes(p.name))
      ?? (incident.restartCount != null ? single(podsOnNode.filter(p => maxRestarts(p) === incident.restartCount)) : null)
      ?? single(podsOnNode);
    if (match) fixes.push({ index: i, podName: match.name, namespace: match.namespace });
    else if (podsOnNode.length === 0) fixes.push({ index: i, drop: true });
  });
  return fixes;
}

// Find incidents with the wrong cluster name
function _findClusterMismatches(incidents, signals) {
  const podClusterByIdentity = new Map((signals.pods ?? []).map(p => [`${p.namespace}/${p.name}`, p.clusterName]));
  const nodeClusterByName    = new Map((signals.nodes ?? []).map(n => [n.name, n.clusterName]));

  const problems = [];
  incidents.forEach((incident, i) => {
    let trueCluster = null;
    if (incident.scope === 'node') {
      trueCluster = nodeClusterByName.get(incident.nodeName);
    } else if (incident.scope === 'pod' && incident.podName) {
      trueCluster = podClusterByIdentity.get(`${incident.namespace}/${incident.podName}`);
    }
    if (!trueCluster && incident.scope === 'pod' && incident.deployment) {
      const owned = (signals.pods ?? []).find(p => p.namespace === incident.namespace && p.ownerName === incident.deployment);
      trueCluster = owned?.clusterName ?? null;
    }
    if (trueCluster && trueCluster !== incident.clusterName) {
      problems.push({ index: i, correctClusterName: trueCluster, claimed: incident.clusterName });
    }
  });
  return problems;
}

const REPLICASET_HASH_SUFFIX_RE = /^(.+)-[a-z0-9]{8,10}$/i;

function _findMissingDeployments(incidents, signals) {
  const podOwnerByIdentity = new Map(
    (signals.pods ?? []).map(p => [`${p.clusterName}/${p.namespace}/${p.name}`, { ownerKind: p.ownerKind, ownerName: p.ownerName }])
  );
  const fixes = [];
  incidents.forEach((incident, i) => {
    if (incident.scope !== 'pod' || incident.deployment || !incident.podName) return;
    const owner = podOwnerByIdentity.get(`${incident.clusterName}/${incident.namespace}/${incident.podName}`);
    if (!owner?.ownerName) return;
    const deployment = owner.ownerKind === 'ReplicaSet'
      ? (owner.ownerName.match(REPLICASET_HASH_SUFFIX_RE)?.[1] ?? owner.ownerName)
      : owner.ownerName;
    fixes.push({ index: i, deployment });
  });
  return fixes;
}

// Resolve the controller that owns a pod
function _resolveController(pod) {
  if (!pod.ownerName) return null;
  const isReplicaSet = pod.ownerKind === 'ReplicaSet';
  const name = isReplicaSet ? (pod.ownerName.match(REPLICASET_HASH_SUFFIX_RE)?.[1] ?? pod.ownerName) : pod.ownerName;
  const kind = isReplicaSet ? 'Deployment' : (pod.ownerKind ?? 'unknown');
  return { groupKey: `${pod.clusterName}/${pod.namespace}/${kind}/${name}`, controllerRef: `${kind.toLowerCase()}/${name}` };
}

// Add sibling pod info to each pod signal
function _annotateSiblingInfo(pods) {
  const groupSizes = new Map();
  pods.forEach(p => {
    const resolved = _resolveController(p);
    if (!resolved) return;
    groupSizes.set(resolved.groupKey, (groupSizes.get(resolved.groupKey) ?? 0) + 1);
  });
  return pods.map(p => {
    const resolved = _resolveController(p);
    return {
      ...p,
      managedByController: !!resolved,
      controllerRef: resolved?.controllerRef ?? null,
      unhealthySiblings: resolved ? groupSizes.get(resolved.groupKey) - 1 : 0,
    };
  });
}

// Find incidents wrongly marked as simple
function _findOvercalledSimple(incidents, annotatedPods) {
  const byIdentity = new Map(annotatedPods.map(p => [`${p.clusterName}/${p.namespace}/${p.name}`, p]));
  const indices = [];
  incidents.forEach((incident, i) => {
    if (incident.complexity !== 'SIMPLE') return;
    if (incident.scope !== 'pod') { indices.push(i); return; }
    let pod = incident.podName ? byIdentity.get(`${incident.clusterName}/${incident.namespace}/${incident.podName}`) : null;
    if (!pod && incident.deployment) {
      pod = annotatedPods.find(p =>
        p.clusterName === incident.clusterName && p.namespace === incident.namespace &&
        p.controllerRef === `deployment/${incident.deployment}`
      );
    }
    if (!pod || !pod.managedByController || pod.unhealthySiblings > 0) indices.push(i);
  });
  return indices;
}

// Compute the blast scope of each incident
function _deriveBlastScope(incident, annotatedPods) {
  if (incident.scope === 'node') return { resource: incident.nodeName ?? 'unknown', controller: null, blast_radius: 'node' };
  if (incident.scope === 'cluster') return { resource: incident.clusterName, controller: null, blast_radius: 'cluster' };

  const resource = `${incident.namespace ?? 'default'}/${incident.podName ?? incident.deployment ?? 'unknown'}`;
  let pod = incident.podName
    ? annotatedPods.find(p => p.clusterName === incident.clusterName && p.namespace === incident.namespace && p.name === incident.podName)
    : null;
  if (!pod && incident.deployment) {
    pod = annotatedPods.find(p =>
      p.clusterName === incident.clusterName && p.namespace === incident.namespace &&
      p.controllerRef === `deployment/${incident.deployment}`
    );
  }
  const controller   = pod?.controllerRef ?? (incident.deployment ? `deployment/${incident.deployment}` : null);
  const blast_radius = pod && pod.unhealthySiblings > 0 ? 'workload' : 'single_pod';
  return { resource, controller, blast_radius };
}

async function _classify(signals) {
  const annotatedPods = _annotateSiblingInfo(signals.pods ?? []);
  const baseMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ ...signals, pods: annotatedPods }) },
  ];

  let result;
  try {
    result = await runStructuredLLMCall(() => llm.invoke(baseMessages));
  } catch (err) {
    console.warn(`[ORCHESTRATOR] classification invalid — attempting one repair round-trip: ${err.message}`);
    const repairMessages = [
      ...baseMessages,
      { role: 'assistant', content: 'Submitting the classified incidents now.' },
      {
        role: 'user',
        content: `Your previous response failed schema validation:\n${err.message}\n\n` +
          `Resend the FULL incidents array with every required field filled in — ` +
          `namespace and (podName or deployment) for scope "pod"; nodeName for scope "node".`,
      },
    ];
    result = await runStructuredLLMCall(() => llm.invoke(repairMessages));
  }

  const gaming = _findScopeGamingIssues(result.incidents, signals);
  if (gaming.length > 0) {
    console.warn(`[ORCHESTRATOR] auto-correcting ${gaming.length} incident(s) that used scope "cluster" as a shortcut: ${gaming.map(g => g.podName).join(', ')}`);
    gaming.forEach(g => {
      result.incidents[g.index] = {
        ...result.incidents[g.index],
        scope: 'pod',
        namespace: g.namespace,
        podName: g.podName,
      };
    });
  }

  const misscoped = _findMisscopedNodeIncidents(result.incidents, signals);
  if (misscoped.length > 0) {
    const dropped = new Set();
    misscoped.forEach(m => {
      const incident = result.incidents[m.index];
      if (m.drop) {
        console.warn(`[ORCHESTRATOR] dropping pod-shaped incident filed under scope "node" (${incident.clusterName}/${incident.nodeName}): node is healthy and no unhealthy pod is on it`);
        dropped.add(m.index);
        return;
      }
      console.warn(`[ORCHESTRATOR] re-scoping pod-shaped incident from node "${incident.nodeName}" to pod ${m.namespace}/${m.podName}`);
      result.incidents[m.index] = { ...incident, scope: 'pod', namespace: m.namespace, podName: m.podName };
    });
    result.incidents = result.incidents.filter((_, i) => !dropped.has(i));
  }

  const clusterMismatches = _findClusterMismatches(result.incidents, signals);
  if (clusterMismatches.length > 0) {
    console.warn(`[ORCHESTRATOR] auto-correcting ${clusterMismatches.length} incident(s) with a wrong clusterName`);
    clusterMismatches.forEach(m => {
      result.incidents[m.index] = { ...result.incidents[m.index], clusterName: m.correctClusterName };
    });
  }

  const missingDeployments = _findMissingDeployments(result.incidents, signals);
  if (missingDeployments.length > 0) {
    console.warn(`[ORCHESTRATOR] backfilling ${missingDeployments.length} incident(s) missing "deployment" from their pod's real owner: ${missingDeployments.map(f => f.deployment).join(', ')}`);
    missingDeployments.forEach(f => {
      result.incidents[f.index] = { ...result.incidents[f.index], deployment: f.deployment };
    });
  }

  const overcalledSimple = _findOvercalledSimple(result.incidents, annotatedPods);
  if (overcalledSimple.length > 0) {
    console.warn(`[ORCHESTRATOR] auto-correcting ${overcalledSimple.length} incident(s) that called complexity SIMPLE without satisfying the deterministic sibling/controller check`);
    overcalledSimple.forEach(i => {
      result.incidents[i] = { ...result.incidents[i], complexity: 'COMPLEX' };
    });
  }
  result.incidents = result.incidents.map(incident => ({
    ...incident,
    blastScope: _deriveBlastScope(incident, annotatedPods),
  }));

  return result.incidents;
}

// Build the dispatch key for an incident
function _dispatchKey(incident) {
  if (incident.scope === 'node') return `node:${incident.clusterName}:${incident.nodeName}`;
  if (incident.scope === 'cluster') return `cluster:${incident.clusterName}`;
  if (incident.correlationTag) return `ns:${incident.namespace ?? 'default'}:corr:${incident.correlationTag}`;
  return `solo:${issueKey(incident)}`;
}

// Resolve dispatch keys for incidents
async function _resolveDispatchKeys(survivorInputs) {
  const resolved = new Map();
  const correlatedGroups = new Map();

  for (const { incident, resourceKey } of survivorInputs) {
    if (incident.correlationTag && incident.scope !== 'node' && incident.scope !== 'cluster') {
      const groupKey = `${incident.namespace ?? 'default'}::${incident.correlationTag}`;
      if (!correlatedGroups.has(groupKey)) correlatedGroups.set(groupKey, []);
      correlatedGroups.get(groupKey).push({ incident, resourceKey });
    } else {
      resolved.set(resourceKey, _dispatchKey(incident));
    }
  }

  await Promise.all([...correlatedGroups.values()].map(async members => {
    const namespace = members[0].incident.namespace ?? 'default';
    const existingPins = await Promise.all(members.map(m => shortMemory.getPinnedDispatchKey(m.resourceKey)));
    const dispatchKey = existingPins.find(Boolean) ?? `ns:${namespace}:corr:${members[0].incident.correlationTag}`;
    await Promise.all(members.map(m => shortMemory.pinDispatchKey(m.resourceKey, dispatchKey, CORRELATION_PIN_TTL_MS)));
    for (const m of members) resolved.set(m.resourceKey, dispatchKey);
  }));

  return resolved;
}

// Describe an incident in one line
function _describeIncident(incident) {
  const where = incident.scope === 'node'
    ? `${incident.clusterName}/${incident.nodeName}`
    : incident.scope === 'cluster'
      ? incident.clusterName
      : `${incident.clusterName}/${incident.namespace ?? 'default'}/${incident.podName ?? incident.deployment ?? 'unknown'}`;
  const correlation = incident.correlationTag ? ` [correlated:${incident.correlationTag}]` : '';
  return `  - [${incident.scope}] ${where} — ${incident.type} (severity=${incident.severity})${correlation}: ${incident.evidenceSummary}`;
}

// Compute priorities for incident groups
function _computeGroupPriorities(survivors) {
  const groupPriority = new Map();
  for (const { incident, dispatchKey } of survivors) {
    const priority = SEVERITY_SCORE[incident.severity] ?? 1;
    groupPriority.set(dispatchKey, Math.max(groupPriority.get(dispatchKey) ?? 0, priority));
  }
  return groupPriority;
}

// Map items with a concurrency limit
async function _mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const running = new Set();

  await new Promise(resolve => {
    function next() {
      if (queue.length === 0 && running.size === 0) return resolve();
      while (queue.length > 0 && running.size < concurrency) {
        const { item, index } = queue.shift();
        const p = Promise.resolve(fn(item))
          .then(result => { results[index] = result; })
          .catch(err => {
            console.error('[ORCHESTRATOR] task failed:', err.message);
            results[index] = undefined;
          })
          .finally(() => {
            running.delete(p);
            next();
          });
        running.add(p);
      }
    }
    next();
  });

  return results;
}

// Gather pods, nodes and events for one cluster
async function _gatherClusterSignals(cluster) {
  const [podsResult, nodesResult, eventsResult] = await Promise.allSettled([
    kubectl.getPods('*', cluster.context, true),
    kubectl.getNodes(cluster.context),
    kubectl.getEvents(cluster.context),
  ]);

  const podsJson   = podsResult.status   === 'fulfilled' ? podsResult.value   : null;
  const nodesJson   = nodesResult.status  === 'fulfilled' ? nodesResult.value  : null;
  const eventsJson  = eventsResult.status === 'fulfilled' ? eventsResult.value : null;

  if (podsResult.status === 'rejected')  console.error(`[${cluster.name}] [ORCHESTRATOR] kubectl get pods failed: ${podsResult.reason?.message}`);
  if (nodesResult.status === 'rejected')  console.warn(`[${cluster.name}] [ORCHESTRATOR] kubectl get nodes failed: ${nodesResult.reason?.message}`);
  if (eventsResult.status === 'rejected') console.warn(`[${cluster.name}] [ORCHESTRATOR] kubectl get events failed: ${eventsResult.reason?.message}`);

  const namespaces = cluster.namespaces ?? ['default'];
  const filteredPods = namespaces.includes('*') || !podsJson
    ? podsJson
    : { ...podsJson, items: (podsJson.items ?? []).filter(p => namespaces.includes(p.metadata?.namespace)) };

  return {
    clusterName: cluster.name,
    reach: {
      unreachable: [podsResult, nodesResult, eventsResult].every(r => r.status === 'rejected'),
      nodeNames: new Set((nodesJson?.items ?? []).map(n => n.metadata?.name).filter(Boolean)),
      podKeys:   new Set((podsJson?.items ?? []).map(p => `${p.metadata?.namespace}/${p.metadata?.name}`)),
    },
    pods:   _summarizePods(filteredPods).map(p => ({ ...p, clusterName: cluster.name })),
    nodes:  _summarizeNodes(nodesJson).map(n => ({ ...n, clusterName: cluster.name })),
    events: _summarizeEvents(eventsJson).map(e => ({ ...e, clusterName: cluster.name })),
  };
}

// Group cluster signals by namespace
function _groupByNamespace(perClusterSignals) {
  const byNamespace = new Map();
  for (const cs of perClusterSignals) {
    for (const pod of cs.pods) {
      const ns = pod.namespace ?? 'default';
      if (!byNamespace.has(ns)) byNamespace.set(ns, { pods: [], events: [] });
      byNamespace.get(ns).pods.push(pod);
    }
  }
  for (const cs of perClusterSignals) {
    for (const event of cs.events) {
      const ns = event.involved?.namespace;
      if (ns && byNamespace.has(ns)) byNamespace.get(ns).events.push(event);
    }
  }
  return byNamespace;
}

async function _runFleetCycle() {
  const clusters = clusterConfigStore.getClusters();
  if (clusters.length === 0) {
    console.log('[ORCHESTRATOR] No clusters configured — nothing to do this cycle');
    return;
  }

  console.log('\n====================================');
  console.log('ORCHESTRATOR FLEET CYCLE STARTED');
  console.log('====================================');
  const t0 = Date.now();

  const clusterConcurrency = loadConfig().CLUSTER_CONCURRENCY;

  const perClusterSignals = await _mapWithConcurrency(clusters, clusterConcurrency, _gatherClusterSignals);

  clusters.forEach((cluster, i) => {
    if (perClusterSignals[i]) runBackgroundChecks(cluster, perClusterSignals[i].reach);
  });

  const byNamespace = _groupByNamespace(perClusterSignals);
  const namespaceEntries = [...byNamespace.entries()];
  const incidentBatches = await _mapWithConcurrency(namespaceEntries, clusterConcurrency, async ([namespace, group]) => {
    try {
      return await _classify({ pods: group.pods, nodes: [], events: group.events });
    } catch (err) {
      console.error(`[ORCHESTRATOR] classification failed for namespace "${namespace}": ${err.message}`);
      return [];
    }
  });

  const allNodes = perClusterSignals.flatMap(cs => cs.nodes);
  let nodeIncidents = [];
  if (allNodes.length > 0) {
    try {
      nodeIncidents = await _classify({ pods: [], nodes: allNodes, events: [] });
    } catch (err) {
      console.error(`[ORCHESTRATOR] node classification failed: ${err.message}`);
    }
  }

  const incidents = [...incidentBatches.flat(), ...nodeIncidents];
  if (incidents.length) {
    console.log(`[ORCHESTRATOR] ${incidents.length} incident(s) classified fleet-wide:`);
    incidents.forEach(incident => console.log(_describeIncident(incident)));
    if (!shortMemory.ready) {
      console.error(`[ORCHESTRATOR] Redis is unreachable — these ${incidents.length} incident(s) will NOT be dispatched this cycle (dedup/queue/locks disabled). This will repeat every cycle until Redis is reachable.`);
    }
  } else {
    console.log('[ORCHESTRATOR] All pods/nodes healthy fleet-wide');
  }

  const survivorInputResults = await Promise.all(incidents.map(async incident => {
    const resourceKey = issueKey(incident);
    if (await shortMemory.cooldownActive(resourceKey)) return null;
    if (escalationStore.hasActiveEscalation(resourceKey)) {
      console.log(`[ORCHESTRATOR] suppressed — active escalation for "${resourceKey}"`);
      return null;
    }
    return { incident, resourceKey };
  }));
  const survivorInputs = survivorInputResults.filter(Boolean);
  const dispatchKeyByResource = await _resolveDispatchKeys(survivorInputs);
  const survivors = await Promise.all(survivorInputs.map(async ({ incident, resourceKey }) => {
    const dispatchKey = dispatchKeyByResource.get(resourceKey);
    await Promise.all([
      shortMemory.upsertIncident(resourceKey, incident),
      shortMemory.addToGroup(dispatchKey, resourceKey),
    ]);
    return { incident, dispatchKey };
  }));
  const groupPriority = _computeGroupPriorities(survivors);
  await Promise.all([...groupPriority].map(
    ([dispatchKey, priority]) => shortMemory.enqueue(dispatchKey, priority)
  ));

  const concurrency = loadConfig().ISSUE_CONCURRENCY;
  const active = await shortMemory.activeWorkflowCount();
  const slots  = Math.max(0, concurrency - active);
  if (slots === 0) {
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\nORCHESTRATOR FLEET CYCLE COMPLETED — ${duration}s (no free workflow slots)`);
    return;
  }

  const dispatchKeys = await shortMemory.dequeue(slots);
  const clusterConfigs = Object.fromEntries(
    clusters.map(c => [c.name, { name: c.name, context: c.context, tier: c.tier ?? 'dev' }])
  );

  await Promise.all(dispatchKeys.map(async dispatchKey => {
    const memberKeys = await shortMemory.getGroupMembers(dispatchKey);
    if (memberKeys.length === 0) return;

    const incidentList = (await Promise.all(memberKeys.map(k => shortMemory.getIncident(k)))).filter(Boolean);
    if (incidentList.length === 0) return;

    const workflowId = randomUUID();
    const locked = await shortMemory.acquireResourceLock(dispatchKey, workflowId);
    if (!locked) return;

    await shortMemory.markWorkflowActive(workflowId);
    await Promise.all([
      shortMemory.clearGroup(dispatchKey),
      ...memberKeys.map(k => shortMemory.clearPin(k)),
    ]);
    console.log(`[ORCHESTRATOR] launching workflow ${workflowId} for ${dispatchKey} (${incidentList.length} incident(s))`);

    const incidentTracer = new IncidentTracer({
      workflowId,
      resource: resourceFromIssue(incidentList[0]),
    });
    incidentTracer.step('orchestrator', {
      classification: incidentList.map(i => i.type),
      severity:       incidentList.map(i => i.severity),
      dedupResult:    'survived',
      action:         'spawn',
      dispatchKey,
    }, {
      resources: incidentList.map(i => ({ ...resourceFromIssue(i), issueKey: issueKey(i) })),
    });

    runWorkflow({ incidents: incidentList, clusterConfigs, workflowId, incidentTracer })
      .then(result => console.log(`[ORCHESTRATOR] workflow ${workflowId} finished — outcome=${result?.outcome ?? 'unknown'}`))
      .catch(err => console.error(`[ORCHESTRATOR] workflow ${workflowId} failed: ${err.message}`))
      .finally(async () => {
        await shortMemory.releaseResourceLock(dispatchKey);
        await shortMemory.markWorkflowInactive(workflowId);
      });
  }));

  const duration = ((Date.now() - t0) / 1000).toFixed(2);
  console.log('\n====================================');
  console.log(`ORCHESTRATOR FLEET CYCLE COMPLETED — ${duration}s`);
  console.log('====================================');
}

const _tracedRunFleetCycle = traceable(_runFleetCycle, {
  name: 'fleet-cycle',
  run_type: 'chain',
});

let _cycleRunning = false;
async function _runFleetCycleGuarded() {
  if (_cycleRunning) {
    console.log('[ORCHESTRATOR] Previous fleet cycle still running — skipping this tick');
    return;
  }
  _cycleRunning = true;
  try {
    await _tracedRunFleetCycle();
  } finally {
    _cycleRunning = false;
  }
}

const OrchestratorAgent = {};

// Start the orchestrator
OrchestratorAgent.start = async function start(intervalMsOverride) {
  console.log('\n====================================');
  console.log('STARTING KUBEPILOT ORCHESTRATOR (v5)');
  console.log('====================================');

  console.log('\n[BOOT] Initializing memory systems...');
  await vectorStore.initialize();
  await episodicMemory.initialize();
  await metricsCollector.initialize();
  await shortMemory.initialize();
  await shortMemory.resetActiveWorkflows();

  const ruleStats = await ruleEngine.stats();
  const memStats   = episodicMemory.stats();
  console.log(`[BOOT] VectorStore  : ${vectorStore.ready ? 'ready' : 'offline (semantic search disabled)'}`);
  console.log(`[BOOT] EpisodicMem  : ${memStats.episodes} episodes in ${memStats.buckets} buckets`);
  console.log(`[BOOT] LearnedRules : ${ruleStats.active} active / ${ruleStats.total} total`);
  console.log(`[BOOT] Prometheus   : ${metricsCollector.isAvailable() ? 'connected — metrics enabled' : 'unavailable — metrics disabled (continuing without)'}`);
  console.log(`[BOOT] ShortMemory  : ${shortMemory.ready ? 'ready (Redis)' : 'offline (dedup/queue/locks disabled)'}`);

  const clusters = clusterConfigStore.getClusters();
  console.log(`\n${clusters.length} cluster(s) configured — gathered and classified together, fleet-wide, every cycle:`);
  clusters.forEach(c => console.log(`  → ${c.name} (${c.tier ?? 'dev'})`));

  rbacWatcher.boot();

  await _runFleetCycleGuarded();

  const intervalMs = intervalMsOverride ?? loadConfig().CYCLE_INTERVAL_MS;
  console.log(`\nNext cycle in ${intervalMs / 1000}s`);

  const loop = async () => {
    try {
      await _runFleetCycleGuarded();
    } catch (err) {
      console.error('[ORCHESTRATOR] Fleet cycle failed:', err.message);
    }
    setTimeout(loop, intervalMs);
  };
  setTimeout(loop, intervalMs);
};

OrchestratorAgent._classify               = _classify;
OrchestratorAgent._findMisscopedNodeIncidents = _findMisscopedNodeIncidents;
OrchestratorAgent._dispatchKey            = _dispatchKey;
OrchestratorAgent._resolveDispatchKeys    = _resolveDispatchKeys;
OrchestratorAgent._describeIncident       = _describeIncident;
OrchestratorAgent._computeGroupPriorities = _computeGroupPriorities;
OrchestratorAgent._summarizePods          = _summarizePods;
OrchestratorAgent._summarizeNodes         = _summarizeNodes;
OrchestratorAgent._summarizeEvents        = _summarizeEvents;
OrchestratorAgent._findScopeGamingIssues  = _findScopeGamingIssues;
OrchestratorAgent._findClusterMismatches  = _findClusterMismatches;
OrchestratorAgent._findMissingDeployments = _findMissingDeployments;
OrchestratorAgent._annotateSiblingInfo    = _annotateSiblingInfo;
OrchestratorAgent._findOvercalledSimple   = _findOvercalledSimple;
OrchestratorAgent._deriveBlastScope       = _deriveBlastScope;
OrchestratorAgent._gatherClusterSignals   = _gatherClusterSignals;
OrchestratorAgent._groupByNamespace       = _groupByNamespace;
OrchestratorAgent._runFleetCycle          = _runFleetCycle;

module.exports = OrchestratorAgent;
