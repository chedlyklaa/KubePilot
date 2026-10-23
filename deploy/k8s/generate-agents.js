'use strict';
// Generates 40-gateways.yaml and 50-agents.yaml — one ServiceAccount + Deployment per agent
// service, all from the same template so their security posture can't drift apart.
//   node deploy/k8s/generate-agents.js
const fs = require('fs');
const path = require('path');

const AGENTS = [
  // name, file, replicas, strategy, kubeconfig Secret (null = no cluster access), remote deps, cpu, mem, note
  { name: 'k8s-read',  file: 'gateways', replicas: 2, strategy: 'RollingUpdate', kubeconfig: 'kubepilot-kubeconfig-read',  deps: [], cpu: '100m', mem: '192Mi',
    note: 'k8s-read — read-only gateway (allowlisted kubectl reads, typed read helpers, health verification).' },
  { name: 'k8s-write', file: 'gateways', replicas: 1, strategy: 'Recreate',      kubeconfig: 'kubepilot-kubeconfig-write', deps: [], cpu: '100m', mem: '192Mi',
    // Verifies the orchestrator's per-step authorization (src/mesh/writeAuth.js). This
    // Secret is mounted ONLY here and in the orchestrator — never in an LLM agent.
    env: ['{ name: MESH_WRITE_SIGNING_KEY, valueFrom: { secretKeyRef: { name: kubepilot-write-signing, key: MESH_WRITE_SIGNING_KEY } } }'],
    note: 'k8s-write — the single point of cluster mutation: exactly 1 replica, Recreate so two never overlap.' },
  { name: 'investigator', file: 'agents', replicas: 2, strategy: 'RollingUpdate', kubeconfig: null, deps: ['K8S_READ', 'REFLECTION'], cpu: '100m', mem: '256Mi',
    note: 'investigator — LLM-heavy: scale replicas (or an HPA on mesh:tasks:investigator.investigate lag).' },
  { name: 'fastpath',  file: 'agents', replicas: 1, strategy: 'RollingUpdate', kubeconfig: null, deps: ['K8S_READ'], cpu: '50m', mem: '192Mi',
    note: 'fastpath — bounded single-pass diagnosis for SIMPLE incidents.' },
  { name: 'planner',   file: 'agents', replicas: 1, strategy: 'RollingUpdate', kubeconfig: null, deps: ['K8S_READ', 'K8S_WRITE'], cpu: '100m', mem: '256Mi',
    note: 'planner — validates steps via k8s-write.dryRun (never mutates); reads Mongo for capacity forecasts.' },
  { name: 'guardian',  file: 'agents', replicas: 2, strategy: 'RollingUpdate', kubeconfig: null, deps: [], cpu: '50m', mem: '192Mi',
    note: 'guardian — independent LLM safety review; stateless, safe to scale.' },
  { name: 'reflection', file: 'agents', replicas: 1, strategy: 'Recreate', kubeconfig: null, deps: [], cpu: '100m', mem: '256Mi',
    note: 'reflection — owns the in-memory episode index: exactly 1 replica, Recreate.' },
];

function render(a) {
  const access = a.kubeconfig ? 'true' : 'false';
  const depEnv = [
    ...a.deps.map(d => `            - { name: AGENT_${d}_MODE, value: remote }`),
    ...(a.env ?? []).map(e => `            - ${e}`),
  ].join('\n');
  const clusterMounts = a.kubeconfig ? `
            - { name: kubeconfig, mountPath: /var/run/kubepilot/kubeconfig, readOnly: true }
            - { name: clusters, mountPath: /app/config/clusters.yaml, subPath: clusters.yaml, readOnly: true }` : '';
  const clusterVolumes = a.kubeconfig ? `
        - name: kubeconfig
          secret: { secretName: ${a.kubeconfig} }
        - name: clusters
          configMap: { name: kubepilot-clusters }` : '';
  return `---
# ${a.note}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubepilot-${a.name}
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${a.name}
  labels: { app.kubernetes.io/name: ${a.name}, app.kubernetes.io/part-of: kubepilot, kubepilot/role: agent }
spec:
  replicas: ${a.replicas}
  strategy: { type: ${a.strategy} }
  selector: { matchLabels: { app.kubernetes.io/name: ${a.name} } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ${a.name}, app.kubernetes.io/part-of: kubepilot, kubepilot/role: agent, kubepilot/cluster-access: "${access}" }
    spec:
      serviceAccountName: kubepilot-${a.name}
      automountServiceAccountToken: false # no Kubernetes API token in this pod at all
      terminationGracePeriodSeconds: 45   # agentHost drains in-flight tasks for up to 30s on SIGTERM
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: ${a.name}
          image: kubepilot
          command: ["node", "agent-services/${a.name}.js"]
          ports: [{ name: http, containerPort: 8080 }]
          envFrom:
            - secretRef: { name: kubepilot-env }
            - configMapRef: { name: kubepilot-config }
          env:
            - { name: REDIS_PASS, valueFrom: { secretKeyRef: { name: kubepilot-redis-acl, key: AGENT_PASS } } }
            - { name: REDIS_URL, value: "redis://agent:$(REDIS_PASS)@redis:6379" }${depEnv ? '\n' + depEnv : ''}
          readinessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 10 }
          livenessProbe: { httpGet: { path: /healthz, port: http }, initialDelaySeconds: 20, periodSeconds: 20 }
          resources:
            requests: { cpu: ${a.cpu}, memory: ${a.mem} }
            limits: { memory: 1Gi }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            - { name: logs, mountPath: /app/logs }${clusterMounts}
      volumes:
        - { name: tmp, emptyDir: {} }
        - { name: logs, emptyDir: {} }${clusterVolumes}
`;
}

const HEADERS = {
  gateways: '# GENERATED by generate-agents.js — edit that, not this file.\n# Cluster gateways: the ONLY agent pods that mount a kubeconfig, each from its own Secret so\n# read and write can hold different identities (see target-cluster-rbac.yaml).\n',
  agents:   '# GENERATED by generate-agents.js — edit that, not this file.\n# LLM agents: no kubeconfig and no ServiceAccount token — only Redis (mesh:* keys via the\n# "agent" ACL user), Mongo where noted, and their LLM endpoint.\n',
};
const FILES = { gateways: '40-gateways.yaml', agents: '50-agents.yaml' };

for (const group of Object.keys(FILES)) {
  const body = AGENTS.filter(a => a.file === group).map(render).join('');
  fs.writeFileSync(path.join(__dirname, FILES[group]), HEADERS[group] + body);
  console.log(`wrote ${FILES[group]}`);
}
