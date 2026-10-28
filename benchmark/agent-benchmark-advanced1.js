#!/usr/bin/env node
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const CTX          = ARGS.context  || 'minikube';
const API          = ARGS.api      || 'http://localhost:3001';
const NS           = ARGS.ns       || 'bench-adv';
const TIMEOUT      = parseInt(ARGS.timeout || '5400', 10);
const POLL         = parseInt(ARGS.poll    || '10', 10);
const IDLE_CONFIRM_TICKS = parseInt(ARGS.idleTicks || '3', 10);
const RESULTS_DIR  = path.join(__dirname, 'results');
const HPA_CLUSTER  = ARGS.cluster  || CTX;
const AUTOSCALE_NS = ARGS.autoscaleNs || 'bench-autoscale-demo';

const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m',
  c: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', n: '\x1b[0m',
};

function kube(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function kubeGlobal(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function kubeApply(yamlStr, namespace) {
  const ns = namespace || NS;
  try {
    return execSync(`kubectl --context=${CTX} -n ${ns} apply -f -`,
      { input: yamlStr, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function waitRollout(name, ns, timeoutSec = 90) {
  try { execFileSync('kubectl', [`--context=${CTX}`, '-n', ns || NS, 'rollout', 'status', `deployment/${name}`, `--timeout=${timeoutSec}s`],
    { encoding: 'utf8', timeout: (timeoutSec + 5) * 1000, stdio: 'pipe' }); } catch {}
}

let TOKEN = '';
async function api(endpoint) {
  const r = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.json();
}
async function login() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@admin.com', password: 'admin' }),
  });
  const d = await r.json();
  TOKEN = d.token;
  if (!TOKEN) throw new Error('Login failed');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const TESTS = [

  {
    name: 'OOMKilled deployment', category: 'basic', weight: 5, kind: 'failure', pod: 'oom-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: oom-dep } }
  template:
    metadata: { labels: { app: oom-dep } }
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`);
    },
    expected: { detected: true, diagnosis: /oom|memory/i, action: 'increase_memory', altActions: ['ESCALATED'] },
  },
  {
    name: 'ImagePullBackOff deployment', category: 'basic', weight: 3, kind: 'failure', pod: 'bad-image',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-image
spec:
  replicas: 1
  selector: { matchLabels: { app: bad-image } }
  template:
    metadata: { labels: { app: bad-image } }
    spec:
      containers:
      - name: app
        image: fakerepo/doesnotexist:v999`);
    },
    expected: { detected: true, diagnosis: /image|pull/i, action: 'noop', altActions: ['ESCALATED', 'restart'] },
  },
  {
    name: 'CrashLoop deployment', category: 'basic', weight: 5, kind: 'failure', pod: 'crashloop-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashloop-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: crashloop-dep } }
  template:
    metadata: { labels: { app: crashloop-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|loop|exit|fail/i, action: 'restart', altActions: ['ESCALATED'] },
  },
  {
    name: 'Bad config rollback', category: 'basic', weight: 8, kind: 'failure', pod: 'bad-config',
    create() {
      kube('create', 'deployment', 'bad-config', '--image=nginx');
      waitRollout('bad-config');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-config
spec:
  replicas: 1
  selector: { matchLabels: { app: bad-config } }
  template:
    metadata: { labels: { app: bad-config } }
    spec:
      containers:
      - name: bad-config
        image: busybox
        command: ["/bin/sh","-c","echo BAD && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /config|exit|crash|error/i, action: 'rollback', altActions: ['restart'] },
  },

  {
    name: 'Cascade: broken database', category: 'cascade', weight: 6, kind: 'failure', pod: 'cascade-db',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: cascade-db
spec:
  replicas: 1
  selector: { matchLabels: { app: cascade-db } }
  template:
    metadata: { labels: { app: cascade-db } }
    spec:
      containers:
      - name: db
        image: busybox
        command: ["/bin/sh","-c","echo DB_CRASH && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|db|database/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },
  {
    name: 'Cascade: app depends on broken db', category: 'cascade', weight: 8, kind: 'failure', pod: 'cascade-app',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: cascade-app
spec:
  replicas: 2
  selector: { matchLabels: { app: cascade-app } }
  template:
    metadata: { labels: { app: cascade-app } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo Connecting to cascade-db... && sleep 3 && echo CONN_REFUSED && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|connect|exit|fail|depend/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },

  {
    name: 'Rollback chain: v3 broken (should rollback)', category: 'rollback', weight: 10, kind: 'failure', pod: 'rollchain',
    create() {
      kube('create', 'deployment', 'rollchain', '--image=nginx');
      waitRollout('rollchain');
      kube('set', 'image', 'deployment/rollchain', 'nginx=httpd:alpine');
      waitRollout('rollchain');
      kube('set', 'image', 'deployment/rollchain', 'nginx=busybox');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollchain
spec:
  replicas: 1
  selector: { matchLabels: { app: rollchain } }
  template:
    metadata: { labels: { app: rollchain } }
    spec:
      containers:
      - name: nginx
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|config|image|broken/i, action: 'rollback', altActions: ['restart', 'ESCALATED'] },
  },

  {
    name: 'Controller: StatefulSet crash', category: 'controller', weight: 5, kind: 'failure', pod: 'sts-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: sts-crash
spec:
  serviceName: sts-crash
  replicas: 1
  selector: { matchLabels: { app: sts-crash } }
  template:
    metadata: { labels: { app: sts-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },
  {
    name: 'Controller: Job failure', category: 'controller', weight: 4, kind: 'failure', pod: 'job-fail',
    create() {
      kubeApply(`apiVersion: batch/v1
kind: Job
metadata:
  name: job-fail
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: worker
        image: busybox
        command: ["/bin/false"]`);
    },
    expected: { detected: true, diagnosis: /exit|fail|job|error/i, action: 'noop', altActions: ['delete_pod', 'ESCALATED'] },
  },
  {
    name: 'Controller: DaemonSet crash', category: 'controller', weight: 4, kind: 'failure', pod: 'ds-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ds-crash
spec:
  selector: { matchLabels: { app: ds-crash } }
  template:
    metadata: { labels: { app: ds-crash } }
    spec:
      containers:
      - name: agent
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]
      tolerations:
      - operator: Exists`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },

  {
    name: 'Behavior: flapping pod (alternate crash/run)', category: 'behavior', weight: 6, kind: 'failure', pod: 'flapper',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: flapper
spec:
  replicas: 1
  selector: { matchLabels: { app: flapper } }
  template:
    metadata: { labels: { app: flapper } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep $(( RANDOM % 10 + 5 )) && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|flap|intermittent/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },
  {
    name: 'Behavior: self-resolving (delayed start)', category: 'behavior', weight: 5, kind: 'failure', pod: 'self-resolve',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: self-resolve
spec:
  replicas: 1
  selector: { matchLabels: { app: self-resolve } }
  template:
    metadata: { labels: { app: self-resolve } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","if [ ! -f /tmp/started ]; then touch /tmp/started && exit 1; fi; sleep 3600"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|transient/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },

  {
    name: 'Isolation: crash in ns-alpha', category: 'isolation', weight: 4, kind: 'failure', pod: 'iso-crash',
    ns: 'bench-ns-alpha',
    create() {
      kubeGlobal('create', 'namespace', 'bench-ns-alpha');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: iso-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: iso-crash } }
  template:
    metadata: { labels: { app: iso-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`, 'bench-ns-alpha');
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },
  {
    name: 'Isolation: crash in ns-beta', category: 'isolation', weight: 4, kind: 'failure', pod: 'iso-crash',
    ns: 'bench-ns-beta',
    create() {
      kubeGlobal('create', 'namespace', 'bench-ns-beta');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: iso-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: iso-crash } }
  template:
    metadata: { labels: { app: iso-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`, 'bench-ns-beta');
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },

  {
    name: 'Resource: CPU throttled deployment', category: 'resource', weight: 5, kind: 'failure', pod: 'cpu-hog',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: cpu-hog
spec:
  replicas: 1
  selector: { matchLabels: { app: cpu-hog } }
  template:
    metadata: { labels: { app: cpu-hog } }
    spec:
      containers:
      - name: hog
        image: busybox
        command: ["/bin/sh","-c","while true; do :; done"]
        resources:
          limits: { cpu: "10m" }`);
    },
    expected: { detected: true, diagnosis: /cpu|throttl|resource|limit/i, action: 'restart', altActions: ['noop', 'ESCALATED', 'scale_down'] },
  },
  {
    name: 'Resource: pending due to CPU quota', category: 'resource', weight: 4, kind: 'failure', pod: 'quota-blocked',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: quota-blocked
spec:
  replicas: 1
  selector: { matchLabels: { app: quota-blocked } }
  template:
    metadata: { labels: { app: quota-blocked } }
    spec:
      containers:
      - name: big
        image: nginx
        resources:
          requests: { cpu: "100", memory: "999Gi" }`);
    },
    expected: { detected: true, diagnosis: /pending|schedul|resource|insufficient/i, action: 'noop', altActions: ['ESCALATED'] },
  },

  {
    name: 'Probe: readiness failing (app starts slow)', category: 'probes', weight: 5, kind: 'failure', pod: 'slow-ready',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: slow-ready
spec:
  replicas: 1
  selector: { matchLabels: { app: slow-ready } }
  template:
    metadata: { labels: { app: slow-ready } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3600"]
        readinessProbe:
          httpGet: { path: /healthz, port: 8080 }
          initialDelaySeconds: 5
          periodSeconds: 3
          failureThreshold: 2`);
    },
    expected: { detected: true, diagnosis: /ready|probe|health|not.ready/i, action: 'restart', altActions: ['noop', 'ESCALATED', 'rollback'] },
  },
  {
    name: 'Probe: liveness killed (hung process)', category: 'probes', weight: 5, kind: 'failure', pod: 'liveness-fail',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: liveness-fail
spec:
  replicas: 1
  selector: { matchLabels: { app: liveness-fail } }
  template:
    metadata: { labels: { app: liveness-fail } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3600"]
        livenessProbe:
          httpGet: { path: /alive, port: 8080 }
          initialDelaySeconds: 5
          periodSeconds: 3
          failureThreshold: 2`);
    },
    expected: { detected: true, diagnosis: /liveness|probe|kill|restart|health/i, action: 'restart', altActions: ['noop', 'ESCALATED', 'rollback'] },
  },

  {
    name: 'Init: init container crash', category: 'init', weight: 5, kind: 'failure', pod: 'init-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: init-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: init-crash } }
  template:
    metadata: { labels: { app: init-crash } }
    spec:
      initContainers:
      - name: setup
        image: busybox
        command: ["/bin/sh","-c","echo INIT_FAIL && exit 1"]
      containers:
      - name: app
        image: nginx`);
    },
    expected: { detected: true, diagnosis: /init|crash|exit|fail/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },
  {
    name: 'Init: init waiting for missing service', category: 'init', weight: 4, kind: 'failure', pod: 'init-wait',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: init-wait
spec:
  replicas: 1
  selector: { matchLabels: { app: init-wait } }
  template:
    metadata: { labels: { app: init-wait } }
    spec:
      initContainers:
      - name: wait-for-db
        image: busybox
        command: ["/bin/sh","-c","until nslookup nonexistent-db; do sleep 2; done"]
      containers:
      - name: app
        image: nginx`);
    },
    expected: { detected: true, diagnosis: /init|pending|wait|dns|not.ready/i, action: 'noop', altActions: ['restart', 'ESCALATED'] },
  },

  {
    name: 'Config: missing ConfigMap mount', category: 'config', weight: 5, kind: 'failure', pod: 'missing-cm',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: missing-cm
spec:
  replicas: 1
  selector: { matchLabels: { app: missing-cm } }
  template:
    metadata: { labels: { app: missing-cm } }
    spec:
      containers:
      - name: app
        image: nginx
        volumeMounts:
        - name: config
          mountPath: /etc/config
      volumes:
      - name: config
        configMap:
          name: nonexistent-config-xyz`);
    },
    expected: { detected: true, diagnosis: /config|mount|volume|missing|not.found/i, action: 'noop', altActions: ['ESCALATED'] },
  },
  {
    name: 'Config: missing Secret mount', category: 'config', weight: 5, kind: 'failure', pod: 'missing-secret',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: missing-secret
spec:
  replicas: 1
  selector: { matchLabels: { app: missing-secret } }
  template:
    metadata: { labels: { app: missing-secret } }
    spec:
      containers:
      - name: app
        image: nginx
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: nonexistent-secret-xyz
              key: password`);
    },
    expected: { detected: true, diagnosis: /secret|mount|missing|not.found|config/i, action: 'noop', altActions: ['ESCALATED'] },
  },

  {
    name: 'Multi: 3-replica crash deployment', category: 'multi', weight: 6, kind: 'failure', pod: 'multi-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-crash
spec:
  replicas: 3
  selector: { matchLabels: { app: multi-crash } }
  template:
    metadata: { labels: { app: multi-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },
  {
    name: 'Multi: mixed healthy + crashing replicas', category: 'multi', weight: 7, kind: 'failure', pod: 'partial-fail',
    create() {
      kube('create', 'deployment', 'partial-fail', '--image=nginx', '--replicas=3');
      waitRollout('partial-fail');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: partial-fail
spec:
  replicas: 3
  selector: { matchLabels: { app: partial-fail } }
  template:
    metadata: { labels: { app: partial-fail } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo BROKEN && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|config|broken/i, action: 'rollback', altActions: ['restart', 'ESCALATED'] },
  },

  {
    name: 'Exit: code 137 OOM (deployment)', category: 'exitcodes', weight: 5, kind: 'failure', pod: 'exit137',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit137
spec:
  replicas: 1
  selector: { matchLabels: { app: exit137 } }
  template:
    metadata: { labels: { app: exit137 } }
    spec:
      containers:
      - name: app
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`);
    },
    expected: { detected: true, diagnosis: /oom|memory|137|kill/i, action: 'increase_memory', altActions: ['ESCALATED'] },
  },
  {
    name: 'Exit: code 127 binary not found (deployment)', category: 'exitcodes', weight: 5, kind: 'failure', pod: 'exit127-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit127-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: exit127-dep } }
  template:
    metadata: { labels: { app: exit127-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/nonexistent-binary"]`);
    },
    expected: { detected: true, diagnosis: /not.found|127|binary|command|exec|entrypoint/i, action: 'rollback', altActions: ['restart', 'ESCALATED'] },
  },
  {
    name: 'Exit: code 126 permission denied (deployment)', category: 'exitcodes', weight: 4, kind: 'failure', pod: 'exit126-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit126-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: exit126-dep } }
  template:
    metadata: { labels: { app: exit126-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/etc/hostname"]`);
    },
    expected: { detected: true, diagnosis: /permission|denied|126|exec|cannot|error/i, action: 'rollback', altActions: ['restart', 'ESCALATED'] },
  },

  {
    name: 'Policy: OOM blocked by exhausted ResourceQuota', category: 'policy', weight: 6,
    kind: 'policyBlock', pod: 'policy-oom', ns: 'bench-policy', expectedRule: /POLICY_QUOTA_EXHAUSTED/,
    create() {
      kubeGlobal('create', 'namespace', 'bench-policy');
      kubeApply(`apiVersion: v1
kind: ResourceQuota
metadata:
  name: tight-quota
spec:
  hard:
    limits.memory: 4Mi`, 'bench-policy');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy-oom
spec:
  replicas: 1
  selector: { matchLabels: { app: policy-oom } }
  template:
    metadata: { labels: { app: policy-oom } }
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`, 'bench-policy');
    },
    expected: { detected: true, diagnosis: /POLICY_QUOTA_EXHAUSTED/, action: 'BLOCKED', altActions: [] },
  },

  {
    name: 'Healthy: nginx', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-nginx',
    create() { kube('run', 'healthy-nginx', '--image=nginx', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: redis', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-redis',
    create() { kube('run', 'healthy-redis', '--image=redis:alpine', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: deployment (2 replicas)', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-dep',
    create() {
      kube('create', 'deployment', 'healthy-dep', '--image=nginx', '--replicas=2');
      waitRollout('healthy-dep');
    },
    expected: { detected: false },
  },
  {
    name: 'Healthy: busybox sleep', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-bb',
    create() { kube('run', 'healthy-bb', '--image=busybox', '--restart=Never', '--', 'sleep', '3600'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: StatefulSet', category: 'healthy', weight: 6, kind: 'healthy', pod: 'healthy-sts',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: healthy-sts
spec:
  serviceName: healthy-sts
  replicas: 1
  selector: { matchLabels: { app: healthy-sts } }
  template:
    metadata: { labels: { app: healthy-sts } }
    spec:
      containers:
      - name: app
        image: nginx`);
    },
    expected: { detected: false },
  },
];

const HPA_CHECKS = [
  {
    name: 'HPA created with min=1 max=5 target=50% is visible via the API',
    async setup() {
      kubeGlobal('create', 'namespace', AUTOSCALE_NS);
      kubeGlobal('-n', AUTOSCALE_NS, 'create', 'deployment', 'hpa-demo', '--image=nginx');
      waitRollout('hpa-demo', AUTOSCALE_NS);
      if (!kubeGlobal('-n', AUTOSCALE_NS, 'get', 'deployment', 'hpa-demo', '--ignore-not-found'))
        throw new Error(`deployment/hpa-demo was not created in namespace "${AUTOSCALE_NS}" — check kubectl output / whether the namespace is stuck Terminating from a previous run`);
      kubeGlobal('-n', AUTOSCALE_NS, 'autoscale', 'deployment/hpa-demo', '--min=1', '--max=5', '--cpu-percent=50');
      if (!kubeGlobal('-n', AUTOSCALE_NS, 'get', 'hpa', 'hpa-demo', '--ignore-not-found'))
        throw new Error(`kubectl autoscale did not create hpa-demo in namespace "${AUTOSCALE_NS}" — run it manually to see the real error`);
    },
    async verify() {
      const d = await api(`/api/autoscaling/hpas?cluster=${encodeURIComponent(HPA_CLUSTER)}`);
      const h = (d.hpas ?? []).find(x => x.target === 'Deployment/hpa-demo' && x.namespace === AUTOSCALE_NS);
      if (!h) return { pass: false, detail: `HPA exists in kubectl but not via /api/autoscaling/hpas?cluster=${HPA_CLUSTER} — check --cluster= matches the "name" in clusters.yaml (context "${CTX}" itself is confirmed reachable, since setup() succeeded)` };
      const ok = h.minReplicas === 1 && h.maxReplicas === 5 && h.cpuTarget === 50;
      return { pass: ok, detail: `min=${h.minReplicas} max=${h.maxReplicas} target=${h.cpuTarget}%` };
    },
  },
  {
    name: 'Editing an HPA (the "Edit" modal\'s PUT) persists the new min/max',
    async setup() {
      const r = await fetch(`${API}/api/autoscaling/hpas/hpa-demo`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster: HPA_CLUSTER, namespace: AUTOSCALE_NS, minReplicas: 2, maxReplicas: 6 }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`PUT /api/autoscaling/hpas/hpa-demo → ${r.status}: ${d.error ?? 'unknown error'}`);
      }
    },
    async verify() {
      const d = await api(`/api/autoscaling/hpas?cluster=${encodeURIComponent(HPA_CLUSTER)}`);
      const h = (d.hpas ?? []).find(x => x.target === 'Deployment/hpa-demo' && x.namespace === AUTOSCALE_NS);
      if (!h) return { pass: false, detail: 'HPA not found after edit' };
      const ok = h.minReplicas === 2 && h.maxReplicas === 6;
      return { pass: ok, detail: `min=${h.minReplicas} max=${h.maxReplicas}` };
    },
  },
];

// Fetch live workflow incidents from the API
async function fetchLiveWorkflows() {
  try {
    const d = await api('/api/live-workflows');
    return Array.isArray(d.items) ? d.items : [];
  } catch { return []; }
}

// Fetch Short Memory dispatch state from the API
async function fetchShortMemoryState() {
  try {
    return await api('/api/live-workflows/short-memory');
  } catch { return null; }
}

// Find the latest incident matching the test target
function matchIncident(items, podName, namespace, afterIso) {
  const searchNs = namespace || NS;
  const afterMs = new Date(afterIso).getTime();
  const candidates = items.filter(it => {
    const r = it.resource ?? {};
    if ((r.namespace ?? '') !== searchNs) return false;
    if (!r.name || !r.name.includes(podName)) return false;
    const startedMs = new Date(it.startedAt).getTime();
    return Number.isFinite(startedMs) && startedMs >= afterMs;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return candidates[0];
}

// Map a kubectl command to a legacy action label
function classifyAction(planSummary, executorAction) {
  const text = `${planSummary ?? ''} ${executorAction ?? ''}`.toLowerCase();
  if (!text.trim()) return 'noop';
  if (/rollout undo|set image|patch.*image/.test(text)) return 'rollback';
  if (/(set resources|patch).*memory/.test(text)) return 'increase_memory';
  if (/rollout restart/.test(text)) return 'restart';
  if (/delete pod/.test(text)) return 'delete_pod';
  if (/scale.*--replicas=0/.test(text)) return 'scale_down';
  if (/\bscale\b/.test(text)) return 'scale_down';
  return 'restart';
}

// Build a decision result from a live incident
function decisionFromIncident(incident) {
  const byComponent = {};
  for (const s of incident.steps) byComponent[s.component] = s.output ?? {};
  const inv = byComponent.investigator, plan = byComponent.planner;
  const guard = byComponent.guardian, pol = byComponent.policy, exec = byComponent.executor;
  const refl = byComponent.reflector;

  const rootCause = [
    (inv?.sub_events ?? []).map(e => e.issue).filter(Boolean).join(' '),
    inv?.root_cause_layer,
  ].filter(Boolean).join(' ') || null;

  const action = (incident.outcome === 'escalated' || refl?.outcome === 'escalated') ? 'ESCALATED'
    : pol?.status === 'FAIL' ? 'BLOCKED'
    : classifyAction(plan?.plan_summary, exec?.action);

  return {
    action, rootCause, risk: guard?.risk_tier ?? null,
    status: incident.outcome ?? (incident.finishedAt ? 'finished' : 'in_progress'),
    incident,
  };
}

async function findDecision(items, podName, namespace, afterIso) {
  const incident = matchIncident(items, podName, namespace, afterIso);
  return incident ? decisionFromIncident(incident) : null;
}

// Find a policy step that blocked the incident
async function findPolicyBlock(items, deploymentName, namespace, rulePattern, afterIso) {
  const incident = matchIncident(items, deploymentName, namespace, afterIso);
  if (!incident) return null;
  const policyStep = incident.steps.find(s => s.component === 'policy' && s.output?.status === 'FAIL');
  if (!policyStep) return null;
  const rules = policyStep.output.blockedRules ?? [];
  if (!rules.some(r => rulePattern.test(r))) return null;
  return { action: 'BLOCKED', rootCause: rules.join('; '), risk: null, status: 'blocked', incident };
}

function checkResolved(podName) {
  try {
    const phase = kube('get', 'pod', podName, '-o', 'jsonpath={.status.phase}');
    if (phase === 'Running') return true;
  } catch {}
  try {
    const out = kube('get', 'pods', '-l', `app=${podName}`, '-o', 'jsonpath={range .items[*]}{.status.phase}{" "}{end}');
    if (out.includes('Running')) return true;
  } catch {}
  return false;
}

const WORKFLOW_STEP = {
  orchestrator: { icon: '🛰',  label: 'Detected' },
  investigator: { icon: '🔎', label: 'Investigator' },
  planner:      { icon: '🧩', label: 'Planner' },
  guardian:     { icon: '🛡',  label: 'Guardian' },
  policy:       { icon: '📋', label: 'Policy' },
  executor:     { icon: '⚙',  label: 'Executor' },
  reflector:    { icon: '🪞', label: 'Reflexion' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(pass, label) {
  return `<span class="badge ${pass ? 'badge-success' : 'badge-danger'}">${esc(label)}</span>`;
}

// Render a step's output fields as HTML
function stepFieldsHtml(output) {
  const entries = Object.entries(output ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '<div class="no-decision">(no additional output)</div>';
  return `<div class="step-fields">${entries.map(([k, v]) =>
    `<div class="step-field"><span class="step-field-key">${esc(k)}</span><span class="step-field-val">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`
  ).join('')}</div>`;
}

function stepsHtml(incident) {
  if (!incident?.steps?.length) return '<div class="no-decision">No live-pipeline steps recorded for this resource.</div>';
  return `<div class="steps">${incident.steps.map(s => {
    const meta = WORKFLOW_STEP[s.component] ?? { icon: '•', label: s.component };
    const dur = s.durationMs != null ? ` <span class="step-time">(${s.durationMs}ms)</span>` : '';
    return `<div class="step">
      <div class="step-head">${meta.icon} ${esc(meta.label)} <span class="step-time">${esc(s.ts)}</span>${dur}</div>
      ${stepFieldsHtml(s.output)}
    </div>`;
  }).join('')}</div>`;
}

function buildHtmlReport(report, results, decisions) {
  const m = report.metrics;
  const metric = (val, lbl) => `<div class="metric"><div class="val">${esc(val)}</div><div class="lbl">${esc(lbl)}</div></div>`;

  const categories = [...new Set(results.map(r => r.category))];
  const rowsHtml = categories.map(cat => {
    const rows = results.filter(r => r.category === cat).map(r => {
      const dec = decisions[r.dKey] ?? null;
      const latency = r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—';
      const resolutionCell = r.resolution.skipped
        ? '<span class="badge badge-dim">n/a</span>'
        : badge(r.resolution.pass, r.resolution.pass ? 'resolved' : 'not resolved');
      const overallBadge = r.unknown
        ? '<span class="badge badge-warn">UNKNOWN</span>'
        : badge(r.detection.pass && r.action.pass, r.detection.pass && r.action.pass ? 'PASS' : 'FAIL');
      const detectionBadge = r.unknown
        ? '<span class="badge badge-warn">pending</span>'
        : r.kind === 'healthy' ? badge(r.detection.pass, r.detection.pass ? 'no false alarm' : 'FALSE POSITIVE') : badge(r.detection.pass, r.detection.pass ? 'detected' : 'missed');
      return `<tr>
        <td>${overallBadge}</td>
        <td>
          <div>${esc(r.name)}</div>
          <div class="mono">${esc(r.pod)}${r.ns ? ` · ns/${esc(r.ns)}` : ''} · weight ${r.weight} · earned ${r.earned.toFixed(1)}</div>
          <details><summary>Live pipeline steps ▸</summary>${stepsHtml(dec?.incident)}</details>
        </td>
        <td>${detectionBadge}</td>
        <td>${r.kind === 'healthy' ? '<span class="badge badge-dim">n/a</span>' : badge(r.diagnosis.pass, r.diagnosis.pass ? 'correct' : 'off')}</td>
        <td>${r.kind === 'healthy' ? '<span class="badge badge-dim">n/a</span>' : `${badge(r.action.pass, r.action.pass ? 'correct' : 'wrong')}<div class="mono">${esc(r.action.detail)}</div>`}</td>
        <td>${resolutionCell}</td>
        <td class="mono">${latency}</td>
      </tr>`;
    }).join('');
    return `<div class="cat-title">${esc(cat)}</div>
    <table>
      <thead><tr><th></th><th>Test</th><th>Detection</th><th>Diagnosis</th><th>Action</th><th>Resolution</th><th>Latency</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>KubePilot Benchmark Report</title>
<style>
  :root { --bg:#0d0f14; --surface:#13161f; --surface-2:#1c1f2e; --border:#2a2d3e; --text:#c8cdd8; --text-dim:#6b7280; --text-head:#f0f2f8; --primary:#6366f1; --success:#22c55e; --warn:#f59e0b; --danger:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 -apple-system,Segoe UI,sans-serif; padding:28px; }
  h1 { color:var(--text-head); font-size:20px; margin:0 0 4px; }
  .subtitle { color:var(--text-dim); margin:0 0 24px; font-size:12.5px; }
  .metrics { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:28px; }
  .metric { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 16px; min-width:130px; }
  .metric .val { font-size:20px; font-weight:700; color:var(--text-head); }
  .metric .lbl { font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.03em; }
  .cat-title { color:var(--primary); font-weight:700; font-size:12.5px; text-transform:uppercase; letter-spacing:.05em; margin:26px 0 8px; }
  table { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:4px; }
  th, td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--border); font-size:12.5px; vertical-align:top; }
  th { color:var(--text-dim); text-transform:uppercase; font-size:10.5px; letter-spacing:.04em; background:var(--surface-2); }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:600; white-space:nowrap; }
  .badge-success { background:rgba(34,197,94,.15); color:var(--success); }
  .badge-danger  { background:rgba(239,68,68,.15); color:var(--danger); }
  .badge-warn    { background:rgba(245,158,11,.15); color:var(--warn); }
  .badge-dim     { background:rgba(107,114,128,.15); color:var(--text-dim); }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--text-dim); margin-top:2px; word-break:break-word; }
  details > summary { cursor:pointer; color:var(--primary); font-size:11.5px; margin-top:6px; }
  .steps { margin-top:8px; display:flex; flex-direction:column; gap:6px; }
  .step { border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--surface-2); }
  .step-head { font-weight:600; color:var(--text-head); font-size:12px; }
  .step-time { color:var(--text-dim); font-weight:400; font-size:10.5px; }
  .step-fields { margin-top:6px; display:flex; flex-direction:column; gap:2px; }
  .step-field { display:flex; gap:6px; font-size:11.5px; }
  .step-field-key { color:var(--text-dim); min-width:130px; flex-shrink:0; }
  .step-field-val { color:var(--text); word-break:break-word; }
  .no-decision { color:var(--text-dim); font-style:italic; font-size:12px; margin-top:6px; }
</style>
</head>
<body>
  <h1>KubePilot Advanced Agent Benchmark</h1>
  <p class="subtitle">cluster=${esc(report.cluster)} &middot; ${esc(report.date)} (UTC) &middot; commit ${esc(report.commit)} &middot; model ${esc(report.model)}</p>
  <p class="subtitle">stop reason: <b>${esc(report.stopReason)}</b>${report.unknownCount > 0 ? ` &mdash; <span style="color:var(--warn)">${report.unknownCount} test(s) UNKNOWN (not confirmed misses — the system hadn't finished or couldn't be reached when polling stopped)</span>` : ' — every result below is a confirmed, real outcome (system verifiably idle or all tests detected)'}</p>
  <div class="metrics">
    ${metric(`${m.weightedScore}%`, 'Weighted score')}
    ${metric(`${(m.detectionAcc * 100).toFixed(0)}%`, 'Detection')}
    ${metric(m.diagnosisAcc != null ? `${(m.diagnosisAcc * 100).toFixed(0)}%` : 'n/a', 'Diagnosis')}
    ${metric(m.actionAcc != null ? `${(m.actionAcc * 100).toFixed(0)}%` : 'n/a', 'Action')}
    ${metric(m.resolutionRate != null ? `${(m.resolutionRate * 100).toFixed(0)}%` : 'n/a', 'Resolution')}
    ${metric(`${(m.falsePositiveRate * 100).toFixed(1)}%`, 'False positives')}
    ${metric(m.avgLatencyMs != null ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : 'n/a', 'Avg latency')}
  </div>
  ${rowsHtml}
</body>
</html>`;
}

// Run the benchmark
async function main() {
  console.log(`\n${C.B}${C.b}━━━ KubePilot Advanced Agent Benchmark ━━━${C.n}`);
  console.log(`${C.d}cluster=${CTX}  ns=${NS}  timeout=${TIMEOUT}s  tests=${TESTS.length}${C.n}\n`);

  await login();
  console.log(`${C.g}  OK${C.n} Logged in\n`);

  try { execFileSync('kubectl', [`--context=${CTX}`, 'create', 'namespace', NS], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); } catch {}

  const benchStartIso = new Date().toISOString();
  const benchStartMs  = Date.now();
  const startTimes = {};
  const results = [];

  const categories = [...new Set(TESTS.map(t => t.category))];

  console.log(`${C.b}[create]${C.n} Deploying ${TESTS.length} test workloads across ${categories.length} categories...`);
  for (const cat of categories) {
    const catTests = TESTS.filter(t => t.category === cat);
    console.log(`\n  ${C.c}${C.B}${cat.toUpperCase()}${C.n} ${C.d}(${catTests.length} tests)${C.n}`);
    for (const t of catTests) {
      process.stdout.write(`    ${C.b}*${C.n} ${t.name}...`);
      startTimes[t.pod + (t.ns || '')] = Date.now();
      try { t.create(); console.log(` ${C.g}created${C.n}`); }
      catch (e) { console.log(` ${C.r}failed: ${e.message}${C.n}`); }
    }
  }

  console.log(`\n${C.b}[poll]${C.n} Waiting for real agent decisions (idle-detection, ${TIMEOUT}s hard cap)...\n`);

  const decisions = {};
  const detectionTimes = {};
  let elapsed = 0;
  let idleTicks = 0;
  let stopReason = 'safety-cap';
  const failureTests = TESTS.filter(t => t.expected.detected !== false);
  const healthyTests = TESTS.filter(t => t.expected.detected === false);

  while (elapsed < TIMEOUT) {
    await sleep(POLL * 1000);
    elapsed += POLL;

    const liveItems = await fetchLiveWorkflows();

    for (const t of TESTS) {
      const dKey = t.pod + (t.ns || '');
      if (decisions[dKey]) continue;
      const dec = t.kind === 'policyBlock'
        ? await findPolicyBlock(liveItems, t.pod, t.ns, t.expectedRule, benchStartIso)
        : await findDecision(liveItems, t.pod, t.ns, benchStartIso);
      if (dec) {
        decisions[dKey] = dec;
        detectionTimes[dKey] = Date.now() - startTimes[dKey];
      }
    }

    const failureDetected = failureTests.filter(t => decisions[t.pod + (t.ns || '')]).length;
    const sm = await fetchShortMemoryState();
    const queueDepth = sm?.queue?.length ?? '?';
    const activeCount = sm?.activeWorkflows?.length ?? '?';
    process.stdout.write(`\r  ${elapsed}s — failures: ${failureDetected}/${failureTests.length} detected   queue=${queueDepth} active=${activeCount}   `);

    if (failureDetected >= failureTests.length) {
      stopReason = 'all-detected';
      break;
    }

    if (sm && sm.ready === false) {
      console.log(`\n\n  ${C.r}${C.B}Short Memory (Redis) is unreachable${C.n} — dispatch is fleet-wide disabled, nothing further will be detected this run.`);
      stopReason = 'shortmemory-offline';
      break;
    }

    const isIdle = sm?.ready && (sm.queue?.length ?? 0) === 0 && (sm.activeWorkflows?.length ?? 0) === 0 && (sm.groups?.length ?? 0) === 0;
    idleTicks = isIdle ? idleTicks + 1 : 0;
    if (idleTicks >= IDLE_CONFIRM_TICKS) {
      console.log(`\n\n  ${C.y}System idle for ${IDLE_CONFIRM_TICKS * POLL}s${C.n} with ${failureTests.length - failureDetected} test(s) still undetected — concluding these are real misses, not stragglers.`);
      stopReason = 'idle-confirmed';
      break;
    }
  }
  if (stopReason === 'safety-cap') {
    console.log(`\n\n  ${C.r}${C.B}Hit the ${TIMEOUT}s safety cap${C.n} while the system was STILL actively working (queue/active workflows non-empty) — remaining undetected tests are genuinely unknown, not confirmed misses. Re-run with a higher --timeout if this keeps happening.`);
  }

  const finalItems = await fetchLiveWorkflows();
  for (const t of TESTS) {
    const dKey = t.pod + (t.ns || '');
    if (decisions[dKey]) continue;
    const dec = t.kind === 'policyBlock'
      ? await findPolicyBlock(finalItems, t.pod, t.ns, t.expectedRule, benchStartIso)
      : await findDecision(finalItems, t.pod, t.ns, benchStartIso);
    if (dec) { decisions[dKey] = dec; detectionTimes[dKey] = Date.now() - startTimes[dKey]; }
  }
  console.log('\n');

  console.log(`${C.B}${C.b}━━━ Results ━━━${C.n}\n`);

  let totalWeight = 0, earnedWeight = 0;
  const latencies = [];
  let falsePositives = 0, trueNegatives = 0;
  let correctDiag = 0, totalDiag = 0;
  let correctAction = 0, totalAction = 0;
  let resolved = 0, totalResolution = 0;
  const categoryScores = {};

  let currentCat = '';
  for (const t of TESTS) {
    if (t.category !== currentCat) {
      currentCat = t.category;
      console.log(`  ${C.c}${C.B}── ${currentCat.toUpperCase()} ──${C.n}`);
    }

    const dKey = t.pod + (t.ns || '');
    const dec = decisions[dKey] ?? null;
    const exp = t.expected;
    const latencyMs = detectionTimes[dKey] ?? null;
    const latencySec = latencyMs ? (latencyMs / 1000).toFixed(1) : null;

    const unknown = t.kind !== 'healthy' && !dec && (stopReason === 'safety-cap' || stopReason === 'shortmemory-offline');

    const r = {
      name: t.name, pod: t.pod, ns: t.ns ?? null, dKey, kind: t.kind, weight: t.weight, category: t.category,
      detection: { pass: false }, diagnosis: { pass: false }, action: { pass: false, detail: '' },
      resolution: { pass: false, skipped: true }, latencyMs, earned: 0, unknown,
    };

    if (t.kind === 'healthy') {
      if (!dec) {
        r.detection = { pass: true }; r.diagnosis = { pass: true }; r.action = { pass: true, detail: 'no action (correct)' };
        r.earned = t.weight; trueNegatives++;
      } else {
        r.detection = { pass: false }; r.action = { pass: false, detail: `FALSE POSITIVE: ${dec.action}` };
        falsePositives++;
      }
    } else {
      if (dec) { r.detection = { pass: true }; r.earned += t.weight * 0.25; if (latencyMs) latencies.push(latencyMs); }

      totalDiag++;
      if (dec?.rootCause && exp.diagnosis?.test(dec.rootCause)) { r.diagnosis = { pass: true }; r.earned += t.weight * 0.25; correctDiag++; }

      totalAction++;
      if (dec?.action) {
        const isExact = dec.action === exp.action;
        const isAlt = !isExact && (exp.altActions ?? []).includes(dec.action);
        if (isExact) { r.action = { pass: true, detail: dec.action }; r.earned += t.weight * 0.35; correctAction++; }
        else if (isAlt) { r.action = { pass: true, detail: `${dec.action} (alt)` }; r.earned += t.weight * 0.20; correctAction++; }
        else { r.action = { pass: false, detail: `${dec.action} (expected: ${exp.action})` }; }
      } else {
        r.action = { pass: false, detail: 'not detected' };
      }

      if (dec?.action && dec.action !== 'noop' && dec.action !== 'ESCALATED' && dec.action !== 'BLOCKED') {
        totalResolution++; const isRes = checkResolved(t.pod);
        r.resolution = { pass: isRes, skipped: false }; if (isRes) { r.earned += t.weight * 0.15; resolved++; }
      }
    }

    totalWeight += t.weight;
    earnedWeight += r.earned;
    results.push(r);
    if (!categoryScores[t.category]) categoryScores[t.category] = { earned: 0, total: 0 };
    categoryScores[t.category].earned += r.earned;
    categoryScores[t.category].total += t.weight;

    const icon = r.unknown ? `${C.y}UNKNOWN` : r.detection.pass && r.action.pass ? `${C.g}PASS` : `${C.r}FAIL`;
    console.log(`    ${icon}${C.n}  ${t.name} ${C.d}(w=${t.weight})${C.n}`);
    if (t.kind !== 'healthy') {
      console.log(`         ${r.detection.pass ? C.g+'D' : C.r+'D'}${C.n} ${r.diagnosis.pass ? C.g+'Dx' : C.r+'Dx'}${C.n} ${r.action.pass ? C.g+'A' : C.r+'A'}${C.n}${!r.resolution.skipped ? (r.resolution.pass ? ` ${C.g}R${C.n}` : ` ${C.r}R${C.n}`) : ''} ${C.d}${r.action.detail}${latencySec ? ` ${latencySec}s` : ''}${C.n}`);
    }
  }

  const ws = totalWeight > 0 ? ((earnedWeight / totalWeight) * 100).toFixed(1) : 0;
  const avgLat = latencies.length ? (latencies.reduce((a,b) => a+b, 0) / latencies.length / 1000).toFixed(1) : 'n/a';
  const p95Lat = latencies.length >= 2 ? (latencies.sort((a,b) => a-b)[Math.floor(latencies.length * 0.95)] / 1000).toFixed(1) : avgLat;
  const fpRate = healthyTests.length > 0 ? ((falsePositives / healthyTests.length) * 100).toFixed(1) : '0.0';

  const unknownCountForLog = results.filter(r => r.unknown).length;
  console.log(`\n${C.B}${C.b}━━━ Metrics ━━━${C.n}\n`);
  console.log(`  Stop reason:          ${stopReason === 'idle-confirmed' || stopReason === 'all-detected' ? C.g : C.y}${stopReason}${C.n}${unknownCountForLog > 0 ? `  ${C.y}(${unknownCountForLog} test(s) UNKNOWN, not confirmed misses — see report)${C.n}` : ''}`);
  console.log(`  Weighted Score:       ${C.B}${ws}%${C.n}`);
  console.log(`  Detection:            ${results.filter(r => r.detection.pass).length}/${TESTS.length}`);
  console.log(`  Diagnosis:            ${correctDiag}/${totalDiag}`);
  console.log(`  Action:               ${correctAction}/${totalAction}`);
  console.log(`  Resolution:           ${resolved}/${totalResolution || 'n/a'}`);
  console.log(`  False Positive Rate:  ${C.B}${fpRate}%${C.n} (${falsePositives}/${healthyTests.length})`);
  console.log(`  Avg Latency:          ${avgLat}s`);
  console.log(`  P95 Latency:          ${p95Lat}s`);

  console.log(`\n  ${C.B}Per-Category:${C.n}`);
  for (const [cat, s] of Object.entries(categoryScores)) {
    const pct = s.total > 0 ? ((s.earned / s.total) * 100).toFixed(0) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    console.log(`    ${cat.padEnd(12)} ${bar} ${pct}%`);
  }

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}

  const unknownCount = results.filter(r => r.unknown).length;
  const report = {
    date: new Date().toISOString(), commit, cluster: CTX, model: process.env.OPENAI_MODEL ?? 'unknown',
    benchmark: 'advanced', timeout: TIMEOUT,
    stopReason, unknownCount,
    metrics: {
      weightedScore: parseFloat(ws), detectionAcc: results.filter(r => r.detection.pass).length / TESTS.length,
      diagnosisAcc: totalDiag > 0 ? correctDiag / totalDiag : null,
      actionAcc: totalAction > 0 ? correctAction / totalAction : null,
      resolutionRate: totalResolution > 0 ? resolved / totalResolution : null,
      falsePositiveRate: healthyTests.length > 0 ? falsePositives / healthyTests.length : 0,
      avgLatencyMs: latencies.length ? latencies.reduce((a,b) => a+b, 0) / latencies.length : null,
      p95LatencyMs: latencies.length >= 2 ? latencies.sort((a,b) => a-b)[Math.floor(latencies.length * 0.95)] : null,
      categoryScores,
    },
    tests: results.map(r => ({
      name: r.name, pod: r.pod, kind: r.kind, weight: r.weight, category: r.category,
      earned: r.earned, detection: r.detection.pass, diagnosis: r.diagnosis.pass,
      action: r.action.pass, resolution: r.resolution.skipped ? null : r.resolution.pass,
      latencyMs: r.latencyMs, actionDetail: r.action.detail, unknown: r.unknown,
    })),
  };

  const filename = `bench-adv-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(report, null, 2));
  console.log(`\n${C.d}Report: benchmark/results/${filename}${C.n}`);

  const htmlFilename = filename.replace('.json', '.html');
  fs.writeFileSync(path.join(RESULTS_DIR, htmlFilename), buildHtmlReport(report, results, decisions));
  console.log(`${C.d}HTML:   benchmark/results/${htmlFilename}${C.n}`);

  const prevFiles = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('bench-adv-') && f.endsWith('.json')).sort() : [];
  if (prevFiles.length >= 2) {
    const prev = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, prevFiles[prevFiles.length - 2])));
    const diff = report.metrics.weightedScore - prev.metrics.weightedScore;
    if (diff < -5) console.log(`\n  ${C.r}${C.B}REGRESSION${C.n} ${C.r}${diff.toFixed(1)}% vs previous${C.n}`);
    else if (diff > 0) console.log(`\n  ${C.g}Improvement: +${diff.toFixed(1)}%${C.n}`);
  }

  console.log(`\n${C.B}${C.b}━━━ Autoscaling API Checks (not agent-scored) ━━━${C.n}\n`);
  const hpaResults = [];
  for (const chk of HPA_CHECKS) {
    process.stdout.write(`    ${C.b}*${C.n} ${chk.name}...`);
    try {
      await chk.setup();
      await sleep(3000);
      const v = await chk.verify();
      console.log(v.pass ? ` ${C.g}PASS${C.n} ${C.d}${v.detail}${C.n}` : ` ${C.r}FAIL${C.n} ${C.d}${v.detail}${C.n}`);
      hpaResults.push({ name: chk.name, pass: v.pass, detail: v.detail });
    } catch (e) {
      console.log(` ${C.r}ERROR: ${e.message}${C.n}`);
      hpaResults.push({ name: chk.name, pass: false, detail: e.message });
    }
  }
  fs.writeFileSync(
    path.join(RESULTS_DIR, filename.replace('.json', '-hpa-checks.json')),
    JSON.stringify(hpaResults, null, 2)
  );
  console.log(`\n  ${C.d}hpa-demo left running in namespace "${AUTOSCALE_NS}" — open the Autoscaling tab to see it.${C.n}`);
  console.log(`  ${C.d}Remove it yourself when done: kubectl --context=${CTX} delete namespace ${AUTOSCALE_NS}${C.n}`);

  console.log(`\n${C.b}[cleanup]${C.n} Removing test namespaces...`);
  for (const n of [NS, 'bench-ns-alpha', 'bench-ns-beta', 'bench-policy']) {
    try { execFileSync('kubectl', [`--context=${CTX}`, 'delete', 'namespace', n, '--ignore-not-found', '--wait=false'],
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }); } catch {}
  }

  console.log(`\n${C.d}Done. Press Ctrl+C to exit.${C.n}\n`);
  if (process.platform === 'win32') await new Promise(() => {});
}

main().catch(err => {
  console.error(`\n${C.r}Fatal: ${err.message}${C.n}`);
  if (process.platform === 'win32') { process.stdin.resume(); process.stdin.on('data', () => process.exit(1)); }
  else process.exit(1);
});
