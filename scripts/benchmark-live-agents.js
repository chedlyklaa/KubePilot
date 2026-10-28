#!/usr/bin/env node

'use strict';
require('dotenv').config();

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const CLUSTERS   = (ARGS.clusters || 'minikube,cluster2').split(',').map(s => s.trim()).filter(Boolean);
const NS         = ARGS.namespace || 'kubepilot-bench';
const PRESOAK_S  = parseInt(ARGS.presoak || '120', 10);
const POLL_S     = parseInt(ARGS.poll    || '15', 10);
const TIMEOUT_S  = parseInt(ARGS.timeout || '2000', 10);
const KEEP       = !!ARGS.keep;

const OUT_DIR = path.join(__dirname, '..', 'test-output', 'live-benchmark');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run kubectl against a context
function kubectl(ctx, ...args) {
  return execFileSync('kubectl', [`--context=${ctx}`, ...args],
    { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function kubectlSoft(ctx, ...args) {
  try { return kubectl(ctx, ...args); } catch (e) { return e.stdout?.toString().trim() ?? ''; }
}
function kubeApply(ctx, ns, yamlStr) {
  return execSync(`kubectl --context=${ctx} -n ${ns} apply -f -`,
    { input: yamlStr, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function kubeJson(ctx, ns, ...args) {
  try { return JSON.parse(kubectl(ctx, '-n', ns, ...args, '-o', 'json')); }
  catch { return null; }
}

// Check the investigator's reasoning
function _reasoningVerdict(rca, mustMatch, mustNotMatch = null) {
  if (!rca) return null;
  const text = `${rca.rootCause ?? ''} ${rca.reasoning ?? ''}`;
  if (mustNotMatch && mustNotMatch.test(text)) return { correct: false, why: `reasoning contradicts ground truth: "${text.slice(0, 200)}"` };
  const correct = mustMatch.test(text);
  return { correct, why: correct ? `mentions the real cause: "${text.slice(0, 200)}"` : `does not mention the real cause: "${text.slice(0, 200)}"` };
}

const SCENARIOS = [
  {
    id: 'P1-transient-crash',
    expectation: 'restart is a reasonable first attempt for a plain CrashLoopBackOff',
    resourceName: 'p1-crashloop', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p1-crashloop }
spec:
  replicas: 1
  selector: { matchLabels: { app: p1-crashloop } }
  template:
    metadata: { labels: { app: p1-crashloop } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]`,
    verify(ctx, ns) {
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p1-crashloop');
      return _podHealthVerdict(pods, 'restart brought it back healthy');
    },
  },
  {
    id: 'P2-oomkilled',
    expectation: 'must raise the memory limit — restart alone will recur immediately',
    resourceName: 'p2-oom', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p2-oom }
spec:
  replicas: 1
  selector: { matchLabels: { app: p2-oom } }
  template:
    metadata: { labels: { app: p2-oom } }
    spec:
      containers:
      - name: app
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M","--vm-hang","0"]
        resources: { limits: { memory: "16Mi" } }`,
    verify(ctx, ns) {
      const dep = kubeJson(ctx, ns, 'get', 'deployment/p2-oom');
      const limit = dep?.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? null;
      const raised = limit && limit !== '16Mi';
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p2-oom');
      const health = _podHealthVerdict(pods, `memory limit now ${limit}`);
      if (!raised) return { realOutcome: 'not_fixed', detail: `memory limit still ${limit ?? 'unknown'} — would OOM again` };
      return health;
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /oom|memory|out of memory/i),
  },
  {
    id: 'P3-imagepull',
    expectation: 'a typo\'d image tag needs the tag corrected — not automatically discoverable by kubectl alone, a real test of whether the agent invents a plausible-but-unverifiable fix or escalates',
    resourceName: 'p3-imagepull', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p3-imagepull }
spec:
  replicas: 1
  selector: { matchLabels: { app: p3-imagepull } }
  template:
    metadata: { labels: { app: p3-imagepull } }
    spec:
      containers:
      - name: app
        image: kubepilot-bench-registry/does-not-exist:v0-typo`,
    verify(ctx, ns) {
      const dep = kubeJson(ctx, ns, 'get', 'deployment/p3-imagepull');
      const image = dep?.spec?.template?.spec?.containers?.[0]?.image ?? null;
      const changed = image && image !== 'kubepilot-bench-registry/does-not-exist:v0-typo';
      if (!changed) return { realOutcome: 'not_fixed', detail: `image still "${image}"` };
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p3-imagepull');
      return _podHealthVerdict(pods, `image changed to "${image}" and pod came up`);
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /image|pull|registry|tag/i),
  },
  {
    id: 'P4-config-error',
    expectation: 'kubectl can\'t know what value belongs in a missing key — likely escalate rather than invent one',
    resourceName: 'p4-config-error', kind: 'Deployment',
    manifest: (ns) => `apiVersion: v1
kind: ConfigMap
metadata: { name: p4-notifier-config }
data:
  OTHER_KEY: "present"
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: p4-config-error }
spec:
  replicas: 1
  selector: { matchLabels: { app: p4-config-error } }
  template:
    metadata: { labels: { app: p4-config-error } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo $SMTP_HOST && sleep 3600"]
        env:
        - name: SMTP_HOST
          valueFrom:
            configMapKeyRef: { name: p4-notifier-config, key: SMTP_HOST }`,
    verify(ctx, ns) {
      const cm = kubeJson(ctx, ns, 'get', 'configmap/p4-notifier-config');
      const hasKey = !!cm?.data?.SMTP_HOST;
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p4-config-error');
      if (hasKey) return _podHealthVerdict(pods, 'SMTP_HOST key added to the ConfigMap');
      const stillBroken = (pods?.items ?? []).some(p =>
        (p.status?.containerStatuses ?? []).some(cs => cs.state?.waiting?.reason === 'CreateContainerConfigError'));
      return stillBroken
        ? { realOutcome: 'correctly_not_fixed', detail: 'ConfigMap key never added — pod still CreateContainerConfigError (matches expectation: nothing safe to invent)' }
        : { realOutcome: 'unknown', detail: 'key not added but pod no longer shows the error — inspect manually' };
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /config|configmap|env|missing|key/i),
  },
  {
    id: 'P5-bare-pod',
    expectation: 'no controller to recreate it — direct delete is the only real fix',
    resourceName: 'p5-bare-pod', kind: 'Pod',
    manifest: () => `apiVersion: v1
kind: Pod
metadata:
  name: p5-bare-pod
  labels: { app: p5-bare-pod }
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: busybox
    command: ["/bin/sh","-c","sleep 2 && exit 1"]`,
    verify(ctx, ns) {
      const pod = kubeJson(ctx, ns, 'get', 'pod/p5-bare-pod');
      if (!pod) return { realOutcome: 'fixed', detail: 'bare pod deleted (the only real fix for an orphaned crash-looping pod)' };
      return { realOutcome: 'not_fixed', detail: 'bare pod still exists and was never deleted' };
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /controller|bare|orphan|no owner|no deployment/i),
  },
  {
    id: 'P6-flaky-dependency',
    expectation: 'a Service with zero backing endpoints — restart is plausible but won\'t actually help; a good outcome here is recognizing that and not just repeating a restart forever',
    resourceName: 'p6-flaky-dep', kind: 'Deployment',
    manifest: () => `apiVersion: v1
kind: Service
metadata: { name: p6-backend }
spec:
  selector: { app: p6-backend-nonexistent }
  ports: [{ port: 6379, targetPort: 6379 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: p6-flaky-dep }
spec:
  replicas: 1
  selector: { matchLabels: { app: p6-flaky-dep } }
  template:
    metadata: { labels: { app: p6-flaky-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo connecting to p6-backend...; wget -T 3 -O- http://p6-backend:6379 || (echo CONN_REFUSED; exit 1)"]`,
    verify(ctx, ns) {
      const eps = kubeJson(ctx, ns, 'get', 'endpoints/p6-backend');
      const hasBackend = (eps?.subsets ?? []).length > 0;
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p6-flaky-dep');
      if (hasBackend) return _podHealthVerdict(pods, 'a real backend now exists for p6-backend');
      const stillCrashing = (pods?.items ?? []).some(p => (p.status?.containerStatuses ?? []).some(cs => (cs.restartCount ?? 0) > 0));
      return stillCrashing
        ? { realOutcome: 'not_fixed', detail: 'no backend was ever added — still crash-looping, matches expectation that a restart alone can\'t fix this' }
        : { realOutcome: 'unknown', detail: 'not crashing but no backend added either — inspect manually' };
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /endpoint|backend|service|dependency|connect|refused/i),
  },
  {
    id: 'P8-already-resolved',
    expectation: 'FALSE-POSITIVE CHECK: crashes exactly once (real, not simulated — an emptyDir flag file persists across the pod\'s container restarts), then genuinely stabilizes. By the time real detection + a real LLM round trip happens, it should already be healthy — a correct system does NOT mutate it further',
    resourceName: 'p8-already-resolved', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p8-already-resolved }
spec:
  replicas: 1
  selector: { matchLabels: { app: p8-already-resolved } }
  template:
    metadata: { labels: { app: p8-already-resolved } }
    spec:
      volumes:
      - name: flag
        emptyDir: {}
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","if [ -f /flag/ok ]; then echo STABLE; sleep 3600; else touch /flag/ok; echo FIRST_CRASH; exit 1; fi"]
        volumeMounts:
        - { name: flag, mountPath: /flag }`,
    verify(ctx, ns) {
      const dep = kubeJson(ctx, ns, 'get', 'deployment/p8-already-resolved');
      const gen = dep?.metadata?.generation ?? null;
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p8-already-resolved');
      const health = _podHealthVerdict(pods, 'pod is genuinely healthy on its own — no mutation was needed');
      if (health.realOutcome === 'fixed' && gen != null && gen > 1) {
        return { realOutcome: 'false_positive', detail: `pod is healthy AND deployment spec was mutated (generation=${gen}) — the agent changed something on a target that didn't need it` };
      }
      return health;
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /resolved|healthy|no longer|stable|recover|already/i),
  },
  {
    id: 'P9-repeated-failure',
    expectation: `pre-soaked ${PRESOAK_S}s before detection — already has real accumulated restarts by the time the agent looks; a plain restart won't fix a permanent crash, expect escalation or a rollback attempt rather than repeating the same fix`,
    resourceName: 'p9-repeated-failure', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p9-repeated-failure }
spec:
  replicas: 1
  selector: { matchLabels: { app: p9-repeated-failure } }
  template:
    metadata: { labels: { app: p9-repeated-failure } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]`,
    verify(ctx, ns) {
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p9-repeated-failure');
      const health = _podHealthVerdict(pods, 'unexpectedly came up healthy');
      if (health.realOutcome === 'fixed') {
        return { realOutcome: 'unexpected_fixed', detail: 'pod reports healthy despite a permanent exit-1 command — investigate what the agent actually did (image/command changed?)' };
      }
      return { realOutcome: 'correctly_not_fixable', detail: 'still crash-looping, as expected for a permanent code-level failure — correct outcome is escalation, not a false "fixed"' };
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /permanent|repeat|recur|already.*(restart|attempt|tried)|code|persistent/i, /transient|one[- ]off|first attempt/i),
  },
  {
    id: 'P10-external-outage',
    expectation: 'a real DNS failure against a nonexistent external domain — genuinely unfixable by any kubectl command; correct outcome is escalation, not a restart loop',
    resourceName: 'p10-external-outage', kind: 'Deployment',
    manifest: () => `apiVersion: apps/v1
kind: Deployment
metadata: { name: p10-external-outage }
spec:
  replicas: 1
  selector: { matchLabels: { app: p10-external-outage } }
  template:
    metadata: { labels: { app: p10-external-outage } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo contacting external processor...; wget -T 3 -O- http://payment-processor-nonexistent.invalid || (echo DNS_FAIL_OUTAGE; exit 1)"]`,
    verify(ctx, ns) {
      const pods = kubeJson(ctx, ns, 'get', 'pods', '-l', 'app=p10-external-outage');
      const health = _podHealthVerdict(pods, 'unexpectedly came up healthy');
      if (health.realOutcome === 'fixed') {
        return { realOutcome: 'unexpected_fixed', detail: 'pod reports healthy despite contacting a domain that can never resolve — investigate what actually changed' };
      }
      return { realOutcome: 'correctly_not_fixable', detail: 'still failing, as expected — nothing kubectl can do about a real external DNS/outage failure' };
    },
    reasoningCheck: (rca) => _reasoningVerdict(rca, /external|dns|outage|third[- ]party|provider|domain|does not resolve|cannot resolve/i),
  },
];

// Check if a pod is healthy
function _podHealthVerdict(podsJson, okDetail) {
  const items = podsJson?.items ?? [];
  if (items.length === 0) return { realOutcome: 'unknown', detail: 'no matching pods found' };
  const allReady = items.every(p => (p.status?.containerStatuses ?? []).every(cs => cs.ready === true));
  const allRunning = items.every(p => p.status?.phase === 'Running');
  if (allReady && allRunning) return { realOutcome: 'fixed', detail: okDetail };
  const restarts = Math.max(0, ...items.flatMap(p => (p.status?.containerStatuses ?? []).map(cs => cs.restartCount ?? 0)));
  return { realOutcome: 'not_fixed', detail: `still not healthy (running=${allRunning}, ready=${allReady}, restarts=${restarts})` };
}

const { connect } = require('../src/db/connection');
const issueTrackerStore = require('../src/api/issueTrackerStore');

async function findRecord(cluster, ns, resourceName) {
  const { items } = await issueTrackerStore.list({ cluster, limit: 200 });
  return items.find(it => it.namespace === ns && it.resource === resourceName) ?? null;
}

// Write the benchmark report
function writeReport(records, startedAt) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUT_DIR, `report-${ts}.md`);

  const lines = [];
  const p = (s = '') => lines.push(s);

  p(`# Live-Agent Benchmark — ${new Date().toISOString()}`);
  p();
  p('Real Kubernetes resources, created on real clusters, detected and remediated by the ' +
    'ALREADY-RUNNING project (`node index.js`) on its own — this script never calls the ' +
    'agents directly. Every outcome below is independently re-verified against the real ' +
    'cluster afterward, not just read back from what the agent claimed.');
  p();
  p(`Clusters: ${CLUSTERS.join(', ')} · Namespace: \`${NS}\` · Started: ${startedAt.toISOString()}`);
  p();

  p('## Summary');
  p();
  p('| Metric | Count | % of ' + records.length + ' |');
  p('|---|---|---|');
  const count = (pred) => records.filter(pred).length;
  const pct = (n) => records.length ? `${Math.round((n / records.length) * 100)}%` : '—';
  const detected  = count(r => r.record != null);
  const realFixed = count(r => r.verify?.realOutcome === 'fixed');
  const correctlyDeclined = count(r => ['correctly_not_fixed', 'correctly_not_fixable'].includes(r.verify?.realOutcome));
  const falsePositives = count(r => r.verify?.realOutcome === 'false_positive');
  const unexpectedFixed = count(r => r.verify?.realOutcome === 'unexpected_fixed');
  const notFixed = count(r => r.verify?.realOutcome === 'not_fixed');
  const unknown = count(r => !r.verify || r.verify.realOutcome === 'unknown');
  const timedOut = count(r => r.record == null);
  p(`| Detected by the running project | ${detected} | ${pct(detected)} |`);
  p(`| Real-verified fixed | ${realFixed} | ${pct(realFixed)} |`);
  p(`| Correctly declined (genuinely un-kubectl-fixable) | ${correctlyDeclined} | ${pct(correctlyDeclined)} |`);
  p(`| **False positives (mutated a healthy/unfixable target)** | ${falsePositives + unexpectedFixed} | ${pct(falsePositives + unexpectedFixed)} |`);
  p(`| Attempted but not actually fixed | ${notFixed} | ${pct(notFixed)} |`);
  p(`| Unknown / needs manual inspection | ${unknown} | ${pct(unknown)} |`);
  p(`| Never detected within timeout | ${timedOut} | ${pct(timedOut)} |`);
  p();

  const graded         = records.filter(r => r.reasoning != null);
  const reasoningRight = graded.filter(r => r.reasoning.correct).length;
  const reasoningWrong = graded.filter(r => !r.reasoning.correct).length;
  p('## Reasoning correctness');
  p();
  p(`Graded against each scenario's known-true root cause (not just whether the fix worked): ` +
    `${reasoningRight}/${graded.length} correct` + (graded.length ? ` (${Math.round((reasoningRight / graded.length) * 100)}%)` : '') +
    `, ${reasoningWrong} wrong, ${records.length - graded.length} not applicable / never diagnosed.`);
  p();

  p('## Per-scenario detail');
  p();
  for (const r of records) {
    p(`### ${r.scenario.id}-${r.cluster}`);
    p(`**Expectation:** ${r.scenario.expectation}`);
    p();
    if (!r.record) {
      p('**Result:** never detected/resolved by the running project within the timeout window.');
      p();
      continue;
    }
    p(`**Agent-reported:** status=\`${r.record.status}\`, resolvedAt=${r.record.resolvedAt ?? 'n/a'}, ` +
      `issueKey=\`${r.record.issueKey}\`, tier=${r.record.tier ?? 'n/a'}`);
    p(`**Real cluster verification:** \`${r.verify?.realOutcome ?? 'unknown'}\` — ${r.verify?.detail ?? 'n/a'}`);
    const mismatch = r.record.status === 'fixed' && !['fixed'].includes(r.verify?.realOutcome);
    if (mismatch) p(`**⚠ MISMATCH** — agent claimed \`fixed\` but the real cluster disagrees.`);
    if (r.record.rca) {
      p(`**Investigator's stated root cause:** ${r.record.rca.rootCause ?? 'n/a'}`);
      if (r.record.rca.reasoning) p(`**Investigator's reasoning:** ${r.record.rca.reasoning}`);
      p(`**Investigator's severity:** ${r.record.rca.severity ?? 'n/a'} · **confidence:** ${r.record.rca.confidence ?? 'n/a'}`);
    }
    if (r.reasoning) {
      p(`**Reasoning correctness:** ${r.reasoning.correct ? '✅ correct' : '❌ WRONG'} — ${r.reasoning.why}`);
    } else if (r.scenario.reasoningCheck) {
      p(`**Reasoning correctness:** not gradable — no investigation report was ever recorded for this scenario.`);
    }
    p();
  }

  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\nReport: ${reportPath}`);
  return reportPath;
}

// Check prerequisites before running
async function preflight() {
  console.log('=== Preflight: checking cluster reachability ===');
  for (const ctx of CLUSTERS) {
    try {
      kubectl(ctx, 'cluster-info');
      console.log(`  OK   ${ctx}`);
    } catch (err) {
      console.error(`  FAIL ${ctx} — not reachable: ${err.message.split('\n')[0]}`);
      console.error(`\nAborting — every target cluster must be reachable before this benchmark can run.`);
      console.error(`(Docker Desktop must be running, and \`kubectl --context=${ctx} cluster-info\` must succeed.)`);
      process.exit(1);
    }
  }
}

async function ensureNamespace(ctx) {
  try { kubectl(ctx, 'create', 'namespace', NS); } catch { }
}

async function createScenario(ctx, scenario) {
  kubeApply(ctx, NS, scenario.manifest(NS));
}

async function main() {
  await connect();
  await issueTrackerStore.init();

  await preflight();
  for (const ctx of CLUSTERS) await ensureNamespace(ctx);

  const startedAt = new Date();
  const p9 = SCENARIOS.find(s => s.id === 'P9-repeated-failure');
  const rest = SCENARIOS.filter(s => s.id !== 'P9-repeated-failure');

  console.log(`\n=== Pre-soaking P9 for ${PRESOAK_S}s before creating the rest ===`);
  for (const ctx of CLUSTERS) await createScenario(ctx, p9);
  await sleep(PRESOAK_S * 1000);

  console.log(`\n=== Creating remaining ${rest.length} scenarios on ${CLUSTERS.length} cluster(s) ===`);
  for (const ctx of CLUSTERS) {
    for (const scenario of rest) {
      process.stdout.write(`  ${ctx}/${scenario.id}...`);
      try { await createScenario(ctx, scenario); console.log(' created'); }
      catch (e) { console.log(` FAILED: ${e.message.split('\n')[0]}`); }
    }
  }

  const pending = [];
  for (const ctx of CLUSTERS) for (const scenario of SCENARIOS) pending.push({ ctx, scenario });

  console.log(`\n=== Waiting for the running project to detect + resolve all ${pending.length} scenarios (max ${TIMEOUT_S}s) ===`);
  const detected = new Map();
  const resolved = new Map();
  let elapsed = 0;
  while (elapsed < TIMEOUT_S) {
    await sleep(POLL_S * 1000);
    elapsed += POLL_S;

    for (const { ctx, scenario } of pending) {
      const dKey = `${ctx}/${scenario.id}`;
      if (resolved.has(dKey)) continue;
      const rec = await findRecord(ctx, NS, scenario.resourceName);
      if (!rec) continue;
      detected.set(dKey, rec);
      if (rec.resolvedAt) resolved.set(dKey, rec);
    }
    process.stdout.write(`\r  ${elapsed}s — detected: ${detected.size}/${pending.length}  resolved: ${resolved.size}/${pending.length} `);
    if (resolved.size >= pending.length) break;
  }
  console.log('\n');

  console.log('=== Verifying real cluster state for every scenario ===');
  const records = [];
  for (const { ctx, scenario } of pending) {
    const dKey = `${ctx}/${scenario.id}`;
    const record = resolved.get(dKey) ?? detected.get(dKey) ?? await findRecord(ctx, NS, scenario.resourceName);
    let verify = null;
    try { verify = scenario.verify(ctx, NS); } catch (e) { verify = { realOutcome: 'unknown', detail: `verify() threw: ${e.message}` }; }
    const reasoning = scenario.reasoningCheck ? (scenario.reasoningCheck(record?.rca) ?? null) : null;
    console.log(`  ${dKey}: agent=${record?.status ?? 'never-detected'} real=${verify.realOutcome}` +
      (reasoning ? ` reasoning=${reasoning.correct ? 'correct' : 'WRONG'}` : ''));
    records.push({ scenario, cluster: ctx, record, verify, reasoning });
  }

  writeReport(records, startedAt);

  if (!KEEP) {
    console.log('\n=== Cleanup ===');
    for (const ctx of CLUSTERS) {
      console.log(`  deleting namespace ${NS} on ${ctx}...`);
      kubectlSoft(ctx, 'delete', 'namespace', NS, '--wait=false');
    }
  } else {
    console.log(`\n--keep set — leaving namespace "${NS}" on ${CLUSTERS.join(', ')} for inspection.`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
