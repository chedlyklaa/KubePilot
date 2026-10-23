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
const { loadConfig }         = require('../config');
const { runStructuredLLMCall } = require('../resilience/llmCircuitBreaker');
const { IncidentListSchema } = require('../orchestrator/schemas');
const { runWorkflow, resumeWorkflow, useCheckpointer } = require('../orchestrator/graph');
const checkpointing          = require('../orchestrator/checkpointing');
const { withClusterIdentity } = require('../services/clusterIdentity');
const { issueKey }           = require('../orchestrator/issueKey');
const { IncidentTracer, resourceFromIssue } = require('../monitoring/incidentTracer');
const { anyRemoteAgent, agentMode, DEFAULT_TIMEOUTS_MS } = require('../mesh/agentClient');
const { getBus }               = require('../mesh/busSingleton');
const { startEffectsConsumer } = require('../mesh/effectsConsumer');

const _config = loadConfig();
const llm = new ChatOpenAI({
  apiKey:  _config.OPENAI_API_KEY,
  model:   _config.OPENAI_MODEL,
  configuration: _config.OPENAI_BASE_URL ? { baseURL: _config.OPENAI_BASE_URL } : undefined,
  temperature: 0,
  // Without this, a busy cluster (many distinct incidents, each now required to carry
  // its own full identifying fields — see SYSTEM_PROMPT/IncidentSchema) can produce a
  // JSON response long enough to hit the provider's default output-token cap mid-object,
  // which fails structured-output parsing entirely (confirmed live, 2026-08-19: 37
  // failing pods -> "Could not parse response content as the length limit was reached")
  // and drops the WHOLE cycle's incidents, not just the ones that didn't fit.
  maxTokens: 8000,
  // functionCalling, not LangChain's default strict json_schema: Mistral rejects the
  // $defs/$ref/oneOf/const schema this union compiles to with a bare 400
  // ("Invalid structured output syntax"); tool-call parameters are accepted everywhere.
}).withStructuredOutput(IncidentListSchema, { method: 'functionCalling' });

const SEVERITY_SCORE = { critical: 4, high: 3, medium: 2, low: 1 };
// §Fix-CorrelationTagDrift — how long a resource's dispatchKey pin survives without
// being reclassified with a correlationTag again. Same order of magnitude as
// ESCALATION_COOLDOWN_MS (graph.js, 30 min) — long enough to comfortably outlive a
// real ISSUE_CONCURRENCY queue wait, short enough that a resource which genuinely
// stopped being reclassified (fixed, or gone) doesn't pin forever.
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

// A restartCount alone never resets, so a long-lived pod (a control-plane static pod,
// coredns, etc.) that restarted weeks/months ago from something totally unrelated (a
// node reboot, a Docker Desktop restart) keeps carrying that count for its entire
// lifetime. Without a recency check, a currently Running/Ready/stable pod like that gets
// fed to the classifier as "bad" every single cycle forever — confirmed live
// (2026-09-04): kube-controller-manager/etcd/kube-apiserver/storage-provisioner etc.,
// all genuinely healthy for 70+ minutes with zero current Warning events, were still
// being reported as active "control plane unhealthy" incidents purely because
// restartCount > 0. Only treat the restart as evidence of an ACTIVE problem if it
// happened recently — Kubernetes exposes exactly this via
// containerStatuses[].lastState.terminated.finishedAt (when the previous instance
// ended). No timestamp available (very old client-go versions, or a restart with no
// recorded lastState) errs toward still flagging it, rather than silently hiding a
// real problem. Shared with _summarizeEvents below — a Warning event has the identical
// staleness problem (see there for why).
//
// RECENT_EVIDENCE_WINDOW_MS/isActiveContainerProblem now live in src/tools/podHealth.js
// (imported above) — the executor's post-fix verification needs the exact same "is this
// container currently a problem" answer this classifier does, so there is one definition
// instead of two that could drift apart.

// ── Raw-signal summarization — field extraction only, NOT issue detection ──
// The LLM does the classification; this just keeps the prompt small and bounded.
function _summarizePods(podsJson) {
  const items = (podsJson?.items ?? []).slice(0, 300);
  return items
    .map(p => {
      const statuses = p.status?.containerStatuses ?? [];
      const phase = p.status?.phase;
      // A Succeeded pod's containers are expected to be !ready/terminated by design —
      // that's normal completion (e.g. a finished Job), not a failure signal. Only
      // flag it "bad" if a container actually terminated with a non-zero exit code.
      const bad = phase === 'Succeeded'
        ? statuses.filter(cs => cs.state?.terminated && cs.state.terminated.exitCode !== 0)
        : statuses.filter(isActiveContainerProblem);
      if ((phase === 'Running' || phase === 'Succeeded') && bad.length === 0) return null; // skip healthy/completed pods
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

// A Warning event's `lastTimestamp`/`eventTime` is exactly the same kind of stale
// evidence restartCount was: Kubernetes keeps events around for its own retention
// window (commonly ~1h in-cluster), so a genuinely resolved problem from an hour ago can
// still be sitting in `get events` output right now with nothing distinguishing it from
// something actively happening. Without a recency check here, the same false-positive
// pattern just fixed for pods (§RECENT_EVIDENCE_WINDOW_MS above) recurs on the event
// side — a one-time restart burst keeps generating "current" evidence for as long as
// the cluster happens to retain the event, independent of whether the pod has been
// stable ever since. Missing/unparseable timestamps err toward keeping the event,
// same fail-safe direction as the pod check.
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

// Namespace-grouped dispatch (architecture-doc §7.6/§9.1): pod/deployment incidents in
// the same namespace dispatch together as one workflow — apps in a namespace are
// usually related, so a shared root cause is worth investigating once, not N times.
// Node incidents aren't a namespace concept, so they keep dispatching individually
// (their own resource key IS their dispatch key — a group of 1 through the same code).
// The classification call itself, split out of _runCycle so a standalone harness (see
// scripts/test-orchestrator-classify.js) can feed it fixture signals and see exactly
// what production would classify — same prompt, same schema, same circuit breaker —
// without needing kubectl, shortMemory, or a live cluster.
// Ground-truth cross-check of the model's own `scope` claim against the raw signals it
// was given. Needed because scope "cluster" requires no identifying field at all, so it's
// the schema's "cheapest" branch — and the model reliably takes that shortcut for a
// clearly pod-owned incident rather than filling in scope "pod"'s required fields, even
// though it plainly knows the real pod (it names it in evidenceSummary). Confirmed live,
// 2026-08-24: neither an explicit prompt instruction against this, nor a corrective
// repair round-trip naming the exact pod it dodged, changed the model's answer — it
// reproduced the identical scope "cluster" both times. So this isn't routed through
// another LLM call at all; _classify() below uses the match returned here to correct the
// incident directly, since the ground truth (the same signals.pods sent to the model) is
// already in hand and doesn't need the model's cooperation to apply.
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

// Ground-truth cross-check of the model's own `clusterName` claim, same reasoning and
// same non-LLM-round-trip approach as _findScopeGamingIssues above: now that one
// classify() call can see evidence from multiple clusters at once (fleet-wide,
// namespace-grouped), the model has to correctly attribute each incident to the right
// cluster, and identity fields like this are exactly what this codebase has already
// proven the model gets wrong under ambiguity when there's no way to double-check it.
// `signals.pods`/`signals.nodes` are tagged with clusterName at gather time (see
// _gatherClusterSignals) — that tag is ground truth, since it comes from which
// cluster's kubectl call actually returned that pod/node, not from the model.
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
    // Deployment-only incidents (no podName): fall back to matching any known pod owned
    // by that deployment in that namespace, since deployments aren't their own tagged
    // signal object — only the pods/nodes actually fetched are.
    if (!trueCluster && incident.scope === 'pod' && incident.deployment) {
      const owned = (signals.pods ?? []).find(p => p.namespace === incident.namespace && p.ownerName === incident.deployment);
      trueCluster = owned?.clusterName ?? null;
    }
    // scope "cluster" incidents have no identity to check against — same known
    // limitation _findScopeGamingIssues already has for genuinely cluster-wide issues.
    if (trueCluster && trueCluster !== incident.clusterName) {
      problems.push({ index: i, correctClusterName: trueCluster, claimed: incident.clusterName });
    }
  });
  return problems;
}

// §Fix-DeploymentBackfill (2026-09-04) — PodIncidentSchema only requires "podName OR
// deployment", and the classifier reliably satisfies that with just podName even when
// the raw signal it was given already includes the pod's real owner (ownerKind/ownerName
// in _summarizePods() output) — nothing forces it to copy that across. This matters far
// more than it looks: issueTrackerStore._resourceOf() (and this file's own issueKey())
// fall back to podName whenever deployment is null, so every pod RECREATION (a "delete
// pod" remediation attempt, a rollout, even the controller just replacing a crashed pod)
// silently resets the incident's entire identity — attempt count, cooldown, and the
// escalate-after-MAX_FIX_ATTEMPTS logic all restart from zero, because the pipeline sees
// a "new" issue each time. Confirmed live (2026-09-04): the same p2-oom Deployment was
// tracked under FIVE different resource names (p2-oom-<hash>-rw59m, -jt8f5, -qbf6b,
// -bl9mv, -mk29w) — one per pod recreation.
//
// A pod's OWN ownerReference is its ReplicaSet, not the Deployment directly (the real
// ownership chain is Deployment -> ReplicaSet -> Pod) — but a ReplicaSet's name is always
// "<deployment>-<pod-template-hash>" by Kubernetes' own naming convention, so stripping
// that hash recovers a stable Deployment identity without an extra kubectl call. Not
// foolproof (a bare ReplicaSet with no owning Deployment would false-strip a real
// trailing segment that happens to look like a hash), but far more stable than a fresh
// pod name every recreation — same "ground truth from the same signals already in hand"
// approach as _findScopeGamingIssues/_findClusterMismatches above.
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

// §Triage (2026-09-04) — deterministic sibling pre-check, plain code, no LLM call, run
// before classification (per pod, on whatever `signals.pods` _classify() was given —
// already the unhealthy-only, per-namespace-group bucket _summarizePods/_groupByNamespace
// produce, so "OTHER unhealthy pods sharing this pod's controller" is just a group-by
// over data already in hand, not a fresh kubectl round-trip per incident — an extra
// synchronous live call per incident would work against the fast path's whole reason for
// existing (making SIMPLE incidents cheap/fast), and _summarizePods' own recency-aware
// definition of "unhealthy" (see isActiveContainerProblem in tools/podHealth.js) already IS "not Running/Ready,
// or restartCount rising", so reusing it here is the honest, non-wasteful interpretation
// rather than re-implementing an equivalent check against a second live list-by-label-
// selector call. Resolves ReplicaSet -> Deployment via the same pod-template-hash-suffix
// convention _findMissingDeployments already relies on; StatefulSet/DaemonSet ownership is
// used directly (no further indirection).
function _resolveController(pod) {
  if (!pod.ownerName) return null;
  const isReplicaSet = pod.ownerKind === 'ReplicaSet';
  const name = isReplicaSet ? (pod.ownerName.match(REPLICASET_HASH_SUFFIX_RE)?.[1] ?? pod.ownerName) : pod.ownerName;
  const kind = isReplicaSet ? 'Deployment' : (pod.ownerKind ?? 'unknown');
  return { groupKey: `${pod.clusterName}/${pod.namespace}/${kind}/${name}`, controllerRef: `${kind.toLowerCase()}/${name}` };
}

// Annotates each pod signal with managedByController/controllerRef/unhealthySiblings —
// injected into the classification prompt context (§Triage's Step 2) so the model doesn't
// have to (and per the codebase's established distrust of model-derived identity fields,
// shouldn't) infer controller/sibling relationships itself.
function _annotateSiblingInfo(pods) {
  const groupSizes = new Map(); // groupKey -> count of unhealthy pods in this bucket
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
      unhealthySiblings: resolved ? groupSizes.get(resolved.groupKey) - 1 : 0, // exclude self
    };
  });
}

// Deterministic backstop, same pattern/placement as _findScopeGamingIssues/
// _findClusterMismatches/_findMissingDeployments above: the classification prompt asks the
// model to only call SIMPLE when unhealthySiblings==0 && managedByController==true, but
// (per this codebase's repeatedly-confirmed experience with prompt-only rules — see
// §Fix-P8/§Fix-RootCauseGate in graph.js) a prompt instruction alone isn't trusted to hold
// 100% of the time for something this consequential (SIMPLE skips the full investigation).
// Run LAST, after scope-gaming/cluster-mismatch/deployment-backfill have already corrected
// the incident's identity fields, so this checks the FINAL namespace/podName/deployment/
// clusterName, not whatever the model originally (possibly wrongly) claimed.
function _findOvercalledSimple(incidents, annotatedPods) {
  const byIdentity = new Map(annotatedPods.map(p => [`${p.clusterName}/${p.namespace}/${p.name}`, p]));
  const indices = [];
  incidents.forEach((incident, i) => {
    if (incident.complexity !== 'SIMPLE') return;
    if (incident.scope !== 'pod') { indices.push(i); return; } // node/cluster incidents are never SIMPLE
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

// Deterministic derivation of blastScope for every incident (SIMPLE or not) — see
// IncidentSchema's comment on why this is never asked of the model. Node/cluster-scope
// incidents have no controller/sibling concept, so their blast_radius is fixed by scope
// alone; pod-scope incidents reuse the same annotated-pod lookup _findOvercalledSimple
// already does, so "workload" vs "single_pod" tracks the identical unhealthySiblings fact
// the complexity gate was just checked against.
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
  // Injected into the prompt (Step 2's deterministic pre-check) and reused after the LLM
  // responds (Step 2's deterministic backstop / blastScope derivation) — computed once.
  const annotatedPods = _annotateSiblingInfo(signals.pods ?? []);
  const baseMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ ...signals, pods: annotatedPods }) },
  ];

  let result;
  try {
    result = await runStructuredLLMCall(() => llm.invoke(baseMessages));
  } catch (err) {
    // One bounded repair round-trip, not a loop, for genuine schema-validation failures
    // (required fields missing outright). The plain circuit-breaker retry
    // (FALLBACK_ENABLED) can't help here: at temperature 0 the identical prompt
    // reproduces the identical invalid output every time (confirmed live, 2026-08-24 —
    // 6 consecutive byte-identical failures across 2 process runs). This only works
    // because it changes the conversation — showing the model its own validation errors
    // and asking it to resend. If this also fails, the error propagates exactly as
    // before and _runCycle() drops the cycle.
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

  // Deterministic salvage for scope "cluster" used as a shortcut — see
  // _findScopeGamingIssues' doc comment for why this is applied directly instead of
  // asking the model to redo it: a corrective round-trip demonstrably doesn't change
  // its answer, but we already have everything needed (the real pod + namespace) to
  // fix it ourselves.
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

  // Run after the scope-gaming fix above so a just-corrected pod/node identity is what
  // gets cross-checked here too, not the pre-correction "cluster" scope it started as.
  const clusterMismatches = _findClusterMismatches(result.incidents, signals);
  if (clusterMismatches.length > 0) {
    console.warn(`[ORCHESTRATOR] auto-correcting ${clusterMismatches.length} incident(s) with a wrong clusterName`);
    clusterMismatches.forEach(m => {
      result.incidents[m.index] = { ...result.incidents[m.index], clusterName: m.correctClusterName };
    });
  }

  // Run last, after scope/cluster are already corrected — so this reads the FINAL
  // namespace/podName/clusterName, not whatever the model originally (possibly wrongly)
  // claimed before those fixes were applied.
  const missingDeployments = _findMissingDeployments(result.incidents, signals);
  if (missingDeployments.length > 0) {
    console.warn(`[ORCHESTRATOR] backfilling ${missingDeployments.length} incident(s) missing "deployment" from their pod's real owner: ${missingDeployments.map(f => f.deployment).join(', ')}`);
    missingDeployments.forEach(f => {
      result.incidents[f.index] = { ...result.incidents[f.index], deployment: f.deployment };
    });
  }

  // §Triage — deterministic backstop for complexity, run after every identity fix above
  // (same "read the FINAL fields" reasoning as _findMissingDeployments), then blastScope
  // derived for every incident regardless of complexity.
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

// Node-scope incidents stay cluster-scoped (cluster segment ADDED here — two clusters
// can legitimately have identically-named nodes, e.g. "worker-1", and a node-scoped fix
// must never merge across clusters the way namespace-scoped ones now deliberately do).
// Cluster-scope incidents (no namespace field at all — see ClusterIncidentSchema) stay
// cluster-scoped like nodes: without this, every cluster-wide incident from EVERY
// cluster fell through to the pod branch's `ns:default` fallback and got merged with
// genuinely unrelated default-namespace pod incidents (found in review, 2026-08-26 — a
// regression from dropping the cluster prefix for the pod branch).
// §Fix-ClusterKeyFragmentation (2026-09-04) — the key used to also include `:${type}`,
// but `type` is freeform LLM text, not a stable identifier (unlike node/pod branches,
// which key off real k8s resource names). Confirmed live: the SAME recurring control-
// plane problem on one cluster produced a different dispatch key almost every cycle —
// "control_plane_unhealthy", "control_plane_degraded", "control_plane_failure",
// "apiserver_failure", "KubernetesSystemPodFailure", etc. — so cooldown/dedup never
// actually caught it, and the queue kept accumulating near-duplicate entries for one
// underlying issue instead of collapsing them. Dropping `:type` makes all cluster-wide
// incidents for one cluster in one cycle group into a single investigation instead of
// type-wording lottery.
//
// §Fix-CorrelationGrouping (2026-09-04) — pod-scope incidents used to ALWAYS drop the
// cluster segment and collapse to `ns:<namespace>` alone, on the theory that apps in the
// same namespace are usually related. Confirmed live this is frequently false: a
// namespace like kube-system holds 8+ genuinely unrelated components (coredns, etcd,
// kube-apiserver, kube-proxy...), and bundling all of them into ONE investigation
// produced a 16-incident group that burned the full 40-iteration safety cap without
// converging on anything. Namespace alone is too coarse a proxy for "actually related."
// Now: incidents the classifier explicitly tied together via a shared "correlationTag"
// (see IncidentSchema/SYSTEM_PROMPT) dispatch together, keyed by namespace+tag so two
// DIFFERENT correlated groups in the same namespace don't merge into each other. An
// incident with no correlationTag — most of them — dispatches on its OWN, keyed by its
// own issueKey (which already includes the cluster segment, so two clusters' unrelated
// same-named pods don't coincidentally merge either). The one thing this intentionally
// preserves from the old behavior: a real cross-cluster rollout ("same bad image in
// cluster A and cluster B") still merges, because the classify() call already sees both
// clusters' evidence together and can — and is now asked to — tag them with the same
// correlationTag.
function _dispatchKey(incident) {
  if (incident.scope === 'node') return `node:${incident.clusterName}:${incident.nodeName}`;
  if (incident.scope === 'cluster') return `cluster:${incident.clusterName}`;
  if (incident.correlationTag) return `ns:${incident.namespace ?? 'default'}:corr:${incident.correlationTag}`;
  return `solo:${issueKey(incident)}`;
}

// §Fix-CorrelationTagDrift (2026-09-22) — _dispatchKey() alone is deterministic for
// node/cluster/solo incidents (always the same string for the same resource, cycle to
// cycle), but NOT for a correlated one: classify() is a stateless, per-cycle LLM call
// with no memory of what correlationTag it used last cycle for a relationship that's
// STILL sitting undispatched (e.g. queue full, or waiting on a free ISSUE_CONCURRENCY
// slot) — it reliably invents a different-but-equivalent tag wording every cycle.
// Confirmed live: 11 distinct "ns:demo-fix-mk:corr:insufficient-cpu-*" queue entries for
// the SAME undispatched incident accumulated within ~5 minutes, each cycle's fresh tag
// minting a brand-new sorted-set entry instead of reinforcing the existing one — the
// resulting queue bloat (62 entries, most of them self-duplicates of 2-3 real issues)
// starves genuinely-new incidents of ISSUE_CONCURRENCY slots for a long time.
//
// Fix: for each LOCAL group of incidents sharing a (namespace, correlationTag) pair
// THIS cycle, check whether ANY of their resourceKeys is already pinned
// (shortMemory.getPinnedDispatchKey) to a dispatchKey from an earlier cycle — reuse
// that one for the WHOLE local group (including any brand-new member) instead of
// trusting this cycle's tag wording to already match a prior one. correlationTag's
// original job — which incidents in THIS classification pass belong together — is
// untouched; only cross-cycle STABILITY of the resulting dispatchKey needed help.
async function _resolveDispatchKeys(survivorInputs) {
  const resolved = new Map(); // resourceKey -> dispatchKey
  const correlatedGroups = new Map(); // "namespace::tag" -> [{ incident, resourceKey }]

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

// One human-readable line per classified incident — the identity, what it is, and why,
// so a cycle's full findings are visible in the logs without having to go read Redis
// directly. Pure/exported for the same reason _dispatchKey is: testable without a live
// LLM call, and reusable by any harness that wants the identical rendering.
function _describeIncident(incident) {
  const where = incident.scope === 'node'
    ? `${incident.clusterName}/${incident.nodeName}`
    : incident.scope === 'cluster'
      ? incident.clusterName
      : `${incident.clusterName}/${incident.namespace ?? 'default'}/${incident.podName ?? incident.deployment ?? 'unknown'}`;
  const correlation = incident.correlationTag ? ` [correlated:${incident.correlationTag}]` : '';
  return `  - [${incident.scope}] ${where} — ${incident.type} (severity=${incident.severity})${correlation}: ${incident.evidenceSummary}`;
}

// Pure grouping step, split out of _runCycle so it's unit-testa  ble without shortMemory:
// given the incidents that survived the cooldown check (each already paired with its
// dispatchKey), collapse them into one priority per dispatchKey — the HIGHEST severity
// among the incidents grouped under it, so a later low-severity incident can't downgrade
// an earlier critical one.
function _computeGroupPriorities(survivors) {
  const groupPriority = new Map(); // dispatchKey -> max priority
  for (const { incident, dispatchKey } of survivors) {
    const priority = SEVERITY_SCORE[incident.severity] ?? 1;
    groupPriority.set(dispatchKey, Math.max(groupPriority.get(dispatchKey) ?? 0, priority));
  }
  return groupPriority;
}

// Bounded-concurrency map — same worker-pool pattern the old per-cluster fleet loop
// used (queue + running Set), extracted into a reusable helper now that gathering AND
// classification both need it, not just one top-level per-cluster loop.
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

// Fetch + summarize one cluster's pods/nodes/events, then tag every entry with its
// origin clusterName — this tag is what lets a single fleet-wide classify() call (and
// _findClusterMismatches' ground-truth check) know which cluster each signal actually
// came from once signals from multiple clusters get merged together downstream.
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
    pods:   _summarizePods(filteredPods).map(p => ({ ...p, clusterName: cluster.name })),
    nodes:  _summarizeNodes(nodesJson).map(n => ({ ...n, clusterName: cluster.name })),
    events: _summarizeEvents(eventsJson).map(e => ({ ...e, clusterName: cluster.name })),
  };
}

// Merge every cluster's tagged pods (and namespace-matching events) into one bucket per
// namespace — this is the actual cross-cluster correlation grouping: two clusters both
// having something in namespace "kp-test" end up in the SAME bucket, classified together
// in one classify() call, so the model can see and compare both clusters' evidence at
// once. Nodes are never namespace-scoped and never merged across clusters — kept out of
// this grouping entirely, classified in their own separate fleet-wide pass.
function _groupByNamespace(perClusterSignals) {
  const byNamespace = new Map(); // namespace -> { pods: [], events: [] }
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

  // ── Gather, per cluster, in parallel ────────────────────────────────────
  // Detection only reads — so it runs as the cluster's reader identity
  // (src/services/clusterIdentity.js; a no-op unless CLUSTER_IDENTITY_MODE=serviceaccount).
  const perClusterSignals = await _mapWithConcurrency(clusters, clusterConcurrency,
    cluster => withClusterIdentity('reader', () => _gatherClusterSignals(cluster)));

  // ── Group by namespace across clusters, then classify once per group ───
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

  // Nodes are fleet-wide, not namespace-grouped — one separate classify() call.
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
    // shortMemory fails open (never throws) when Redis is unreachable, but that also
    // means enqueue()/dequeue() silently no-op — every cycle still pays for real
    // gather+classify LLM calls but dispatches nothing, with no ongoing sign anything
    // is wrong beyond one line at boot (found in review, 2026-08-26). Repeat this loudly
    // every affected cycle instead of leaving it easy to miss.
    if (!shortMemory.ready) {
      console.error(`[ORCHESTRATOR] Redis is unreachable — these ${incidents.length} incident(s) will NOT be dispatched this cycle (dedup/queue/locks disabled). This will repeat every cycle until Redis is reachable.`);
    }
  } else {
    console.log('[ORCHESTRATOR] All pods/nodes healthy fleet-wide');
  }

  // ── Dedup + group by dispatch key + enqueue ─────────────────────────────
  // A dispatch key's priority is the HIGHEST severity among the incidents grouped
  // under it this cycle — computed locally before enqueueing (once per group, not
  // once per incident) so a later low-severity incident can't downgrade an earlier
  // critical one's priority.
  // Independent per incident (cooldown/upsert/group-add on different resource keys
  // don't depend on each other's results), so run them concurrently rather than
  // serializing N incidents x multiple Redis round-trips.
  const survivorInputResults = await Promise.all(incidents.map(async incident => {
    const resourceKey = issueKey(incident);
    if (await shortMemory.cooldownActive(resourceKey)) return null;
    // §Fix-EscalationBounce (2026-09-09) — cooldownActive alone only holds off
    // reclassification for ESCALATION_COOLDOWN_MS (30 min, see graph.js), after which an
    // still-unresolved (because nobody's acted on the escalation yet) incident got
    // reclassified, re-enqueued, and re-run through a full Investigator/Planner/Guardian
    // pass just to immediately re-escalate again (attempt was already >= MAX_FIX_ATTEMPTS)
    // — burning a full workflow purely to hit escalate()'s own pending-dedup. An incident
    // with an ACTIVE escalation (pending/acknowledged/in_progress/need_help — see
    // escalationStore.hasActiveEscalation) is a human's problem now; leave it alone
    // entirely until they resolve it (fixed/not_fixed), rather than bouncing between
    // "give up → wait → try again → give up" forever.
    if (escalationStore.hasActiveEscalation(resourceKey)) {
      // §Fix-SilentSuppression (2026-09-11) — this drop used to be indistinguishable
      // from "no incident detected" in the logs; confirmed live (noop-repro, 2026-09-11)
      // this made a stale escalation from an earlier run look like the incident never
      // ran at all. Log-only — behavior unchanged.
      console.log(`[ORCHESTRATOR] suppressed — active escalation for "${resourceKey}"`);
      return null;
    }
    return { incident, resourceKey };
  }));
  const survivorInputs = survivorInputResults.filter(Boolean);
  // §Fix-CorrelationTagDrift — resolved as one batch (not per-incident independently)
  // because a correlated group's dispatchKey choice depends on ALL of its members'
  // pins, not just one incident in isolation — see _resolveDispatchKeys.
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

  // ── Dequeue + launch up to (concurrency - active) workflows, fleet-wide ─
  // Each concurrency slot is one dispatch key (a namespace across every cluster that has
  // something in it, or a single cluster's node), which may bundle several incidents —
  // possibly from several clusters — into a single coordinated workflow.
  const concurrency = loadConfig().ISSUE_CONCURRENCY;
  const active = await shortMemory.activeWorkflowCount();
  const slots  = Math.max(0, concurrency - active);
  if (slots === 0) {
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\nORCHESTRATOR FLEET CYCLE COMPLETED — ${duration}s (no free workflow slots)`);
    return;
  }

  const dispatchKeys = await shortMemory.dequeue(slots);
  // clusterConfigs is the full fleet map, not just the cluster(s) obviously present in
  // a given dispatch key's incidents — cheap to build (no kubectl calls) and a
  // re-diagnose loop inside runWorkflow() could otherwise need to resolve a cluster
  // that wasn't in the initial incident list.
  const clusterConfigs = Object.fromEntries(
    clusters.map(c => [c.name, { name: c.name, context: c.context, tier: c.tier ?? 'dev' }])
  );

  // Each dispatchKey's setup is independent (its own lock, own group) — process them
  // concurrently instead of serializing one dispatchKey's full chain before starting
  // the next.
  await Promise.all(dispatchKeys.map(async dispatchKey => {
    const memberKeys = await shortMemory.getGroupMembers(dispatchKey);
    if (memberKeys.length === 0) return; // group emptied between enqueue and dequeue

    const incidentList = (await Promise.all(memberKeys.map(k => shortMemory.getIncident(k)))).filter(Boolean);
    if (incidentList.length === 0) return; // all members expired between enqueue and dequeue

    const workflowId = randomUUID();
    const locked = await shortMemory.acquireResourceLock(dispatchKey, workflowId);
    if (!locked) return; // another workflow already owns this namespace/node

    await shortMemory.markWorkflowActive(workflowId);
    // Remembered until it finishes, so a restart mid-run can resume it (see
    // _resumeInterruptedWorkflows) instead of silently dropping it.
    await shortMemory.registerInflight(workflowId, dispatchKey);
    // Consumed — any new incidents landing in this dispatch key next cycle start a
    // fresh group rather than being silently absorbed into this in-flight one. Also
    // clears each member's correlation pin (§Fix-CorrelationTagDrift) — this
    // dispatchKey is about to actually run, so a LATER, genuinely new incident on the
    // same resource should be free to land under a fresh group instead of being pulled
    // back into this one just because a pin from before dispatch was still live.
    await Promise.all([
      shortMemory.clearGroup(dispatchKey),
      ...memberKeys.map(k => shortMemory.clearPin(k)),
    ]);
    console.log(`[ORCHESTRATOR] launching workflow ${workflowId} for ${dispatchKey} (${incidentList.length} incident(s))`);

    // Developer-only per-pod decision tracer (src/monitoring/incidentTracer.js) — one
    // instance per spawned workflow, same lifecycle/threading convention as the
    // WorkflowTracer below. `resource` defaults to the group's first incident for a
    // solo dispatch; a namespace group logs one line per incident via `resources` below
    // so `trace pod <ns>/<name>` still finds it regardless of grouping. Deliberately
    // only logged HERE, at the point an incident actually gets a workflowId — an
    // incident that got deduped (cooldownActive) or stayed queued this cycle (no free
    // slot) never reaches this line and so gets no trace entry this cycle.
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

    // Fire-and-forget — the graph run outlives this cycle; Short Memory (not this
    // in-process await) is what future cycles check to respect the concurrency cap.
    // Measurement (Phase 1) — runWorkflow()'s resolved result (carrying `outcome`) used
    // to be silently discarded here (only .catch() read anything); logging it costs
    // nothing and the real per-workflow detail now lands in WorkflowTrace regardless
    // (see graph.js's runWorkflow, which persists it itself before resolving).
    runWorkflow({ incidents: incidentList, clusterConfigs, workflowId, incidentTracer })
      .then(result => console.log(`[ORCHESTRATOR] workflow ${workflowId} finished — outcome=${result?.outcome ?? 'unknown'}`))
      .catch(err => console.error(`[ORCHESTRATOR] workflow ${workflowId} failed: ${err.message}`))
      .finally(() => _releaseWorkflow(workflowId, dispatchKey));
  }));

  const duration = ((Date.now() - t0) / 1000).toFixed(2);
  console.log('\n====================================');
  console.log(`ORCHESTRATOR FLEET CYCLE COMPLETED — ${duration}s`);
  console.log('====================================');
}

// Everything a dispatched (or resumed) workflow holds, released together when it ends.
async function _releaseWorkflow(workflowId, dispatchKey) {
  await shortMemory.releaseResourceLock(dispatchKey);
  await shortMemory.markWorkflowInactive(workflowId);
  await shortMemory.clearInflight(workflowId);
}

// Boot-time: continue workflows a previous process life left mid-run (crash, deploy,
// nodemon reload) from their last LangGraph checkpoint, instead of dropping them and
// waiting for a later detection cycle to redispatch from scratch. Runs BEFORE the first
// fleet cycle so resumed workflows re-take their dispatch-key lock (and a concurrency
// slot) before new dispatch could double-book the same namespace/node.
//
// A workflow that can't be resumed (checkpointing off, already finished, interrupted in
// the executor without an idempotent k8s-write — see graph.js _resumeDecision, or its lock
// now owned by another workflow) is released and simply falls back to the old behavior.
async function _resumeInterruptedWorkflows() {
  const inflight = await shortMemory.listInflight();
  if (inflight.length === 0) return;
  console.log(`[BOOT] Resume       : ${inflight.length} workflow(s) were in flight when the previous process stopped`);

  for (const { workflowId, dispatchKey } of inflight) {
    const owned = await shortMemory.reclaimResourceLock(dispatchKey, workflowId);
    if (!owned) {
      console.warn(`[BOOT] Resume       : ${workflowId} (${dispatchKey}) — lock now held by another workflow, dropping`);
      await shortMemory.clearInflight(workflowId);
      continue;
    }
    await shortMemory.markWorkflowActive(workflowId);

    // Fire-and-forget like a fresh dispatch — decide synchronously enough to log, run in the background.
    resumeWorkflow({ workflowId })
      .then(r => {
        if (r.resumed) console.log(`[ORCHESTRATOR] resumed workflow ${workflowId} finished — outcome=${r.result?.outcome ?? 'unknown'}`);
        else console.log(`[BOOT] Resume       : ${workflowId} (${dispatchKey}) not resumed — ${r.reason}`);
      })
      .catch(err => console.error(`[ORCHESTRATOR] resumed workflow ${workflowId} failed: ${err.message}`))
      .finally(() => _releaseWorkflow(workflowId, dispatchKey));
  }
}

// One root LangSmith trace per fleet cycle — the classification calls and every
// runWorkflow() the cycle dispatches nest under it automatically via traceable()'s
// AsyncLocalStorage context propagation, no manual cycleId threading needed. Replaces
// the old per-cluster trace (`${clusterName}-cycle`) now that there's one fleet-wide
// cycle instead of one per cluster instance.
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

// ── Public interface ─────────────────────────────────────────────────────────
// A plain object, not a class — there is no more "one instance per cluster" concept to
// encapsulate. clusterConfigStore.getClusters() is read fresh at the top of every
// _runFleetCycle() tick, so there's no cached per-cluster state left to hot-reload
// either: clusters.yaml changes just take effect on the next tick naturally, which is
// why the old onChange()/_reconcileAgents() hot-reload machinery is gone, not replaced.
const OrchestratorAgent = {};

// Entry point for the v5 pipeline — called unconditionally from index.js's autonomous
// mode, in place of the legacy `new FleetOrchestrator().start(...)`.
OrchestratorAgent.start = async function start(intervalMsOverride) {
  console.log('\n====================================');
  console.log('STARTING KUBEPILOT ORCHESTRATOR (v5)');
  console.log('====================================');

  console.log('\n[BOOT] Initializing memory systems...');
  await vectorStore.initialize();
  await episodicMemory.initialize();
  await metricsCollector.initialize();
  await shortMemory.initialize();
  // A fresh process can't have any workflow genuinely in flight yet — anything already
  // sitting in sm:active:fleet is necessarily leaked from a previous process life (e.g.
  // nodemon restarting mid-workflow, which abandons the in-memory .finally() cleanup
  // without ever touching Redis). Left alone, leaked entries permanently consume
  // ISSUE_CONCURRENCY slots and silently wedge every future cycle's dispatch step.
  await shortMemory.resetActiveWorkflows();

  // Durable workflow state — must be up before anything is dispatched or resumed.
  const saver = await checkpointing.initCheckpointer();
  useCheckpointer(saver);
  console.log(`[BOOT] Checkpoints  : ${saver ? 'MongoDB (workflows resume after a restart)' : checkpointing.resumeEnabled() ? 'unavailable — no resume after restart' : 'disabled (WORKFLOW_RESUME_ENABLED=false)'}`);

  const ruleStats = await ruleEngine.stats();
  const memStats   = episodicMemory.stats();
  console.log(`[BOOT] VectorStore  : ${vectorStore.ready ? 'ready' : 'offline (semantic search disabled)'}`);
  console.log(`[BOOT] EpisodicMem  : ${memStats.episodes} episodes in ${memStats.buckets} buckets`);
  console.log(`[BOOT] LearnedRules : ${ruleStats.active} active / ${ruleStats.total} total`);
  console.log(`[BOOT] Prometheus   : ${metricsCollector.isAvailable() ? 'connected — metrics enabled' : 'unavailable — metrics disabled (continuing without)'}`);
  console.log(`[BOOT] ShortMemory  : ${shortMemory.ready ? 'ready (Redis)' : 'offline (dedup/queue/locks disabled)'}`);

  // Agent Mesh — only when at least one agent runs as its own service. Remote agents'
  // store writes (token counters, incident stages) arrive on mesh:effects and are
  // applied here, in the process that owns those stores.
  const remoteAgents = Object.keys(DEFAULT_TIMEOUTS_MS).filter(name => agentMode(name) === 'remote');
  if (anyRemoteAgent()) {
    const bus = await getBus('orchestrator');
    await startEffectsConsumer(bus);
    console.log(`[BOOT] AgentMesh    : remote → ${remoteAgents.join(', ')} (instance ${bus.sender})`);
  } else {
    console.log('[BOOT] AgentMesh    : all agents in-process (AGENT_*_MODE=local)');
  }

  const clusters = clusterConfigStore.getClusters();
  console.log(`\n${clusters.length} cluster(s) configured — gathered and classified together, fleet-wide, every cycle:`);
  clusters.forEach(c => console.log(`  → ${c.name} (${c.tier ?? 'dev'})`));

  rbacWatcher.boot();

  await _resumeInterruptedWorkflows();

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

// Exported for unit testing the dispatch-key/grouping logic in isolation (see
// orchestratorAgent.test.js) without mocking kubectl/LLM/shortMemory, and for test
// harnesses that need the fleet-gathering pieces directly (see
// scripts/test-orchestrator-conflict-live.js).
OrchestratorAgent._classify               = _classify;
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
