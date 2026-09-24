import { describe, it, expect, beforeAll } from 'vitest';

// orchestratorAgent.js pulls in ../config (OPENAI_API_KEY/OPENAI_MODEL/
// NOTIFICATION_SECRET) transitively — same pattern as graph.test.js/shortMemory.test.js:
// set required env vars before the module graph loads, via a dynamic (non-hoisted) import.
process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

let OrchestratorAgent;

beforeAll(async () => {
  ({ default: OrchestratorAgent } = await import('./orchestratorAgent.js'));
});

describe('_dispatchKey', () => {
  it('groups a node-scoped incident under its own cluster+node key', () => {
    expect(OrchestratorAgent._dispatchKey({ scope: 'node', clusterName: 'prod-eks', nodeName: 'ip-10-0-1-5' }))
      .toBe('node:prod-eks:ip-10-0-1-5');
  });

  it('scopes node incidents to different keys across clusters, even with identical node names', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'node', clusterName: 'cluster-a', nodeName: 'worker-1' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'node', clusterName: 'cluster-b', nodeName: 'worker-1' });
    expect(a).not.toBe(b);
  });

  // §Fix-CorrelationGrouping (2026-09-04) — an incident with no correlationTag (the
  // common case) no longer groups by namespace alone; it dispatches on its own, keyed by
  // its own identity. Namespace name is too coarse a proxy for "actually related" (found
  // live: kube-system's 8+ unrelated components all bundled into one 16-incident
  // investigation that never converged).
  it('dispatches an uncorrelated pod-scoped incident on its own, keyed by its own identity', () => {
    const key = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'prod-eks', namespace: 'payments', podName: 'api-1' });
    expect(key).toBe('solo:prod-eks/payments/api-1');
  });

  it('falls back to the "default" namespace when the incident has none, still solo', () => {
    const key = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'prod-eks', namespace: null, podName: 'api-1' });
    expect(key).toBe('solo:prod-eks/default/api-1');
  });

  it('does NOT merge the same namespace name across different clusters when neither incident declares a correlation', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'api-1' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-b', namespace: 'payments', podName: 'api-1' });
    expect(a).not.toBe(b);
  });

  // The mechanism this REPLACES blind namespace-merging with: only incidents the
  // classifier explicitly tied together via a shared correlationTag dispatch together —
  // this is what preserves the real cross-cluster correlation case ("same bad image
  // rolled out to cluster A and cluster B") on purpose, without also bundling every
  // unrelated same-namespace incident.
  it('groups incidents sharing the SAME correlationTag under the SAME key, even across different clusters', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'api-1', correlationTag: 'shared-image-rollout-v2.3' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-b', namespace: 'payments', podName: 'api-1', correlationTag: 'shared-image-rollout-v2.3' });
    expect(a).toBe(b);
  });

  it('keeps DIFFERENT correlationTags in the same namespace as separate dispatch groups', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'api-1', correlationTag: 'db-outage-cascade' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'cache-1', correlationTag: 'cache-eviction-storm' });
    expect(a).not.toBe(b);
  });

  // Regression test: found in review 2026-08-26 — scope:"cluster" incidents have no
  // namespace field at all (see ClusterIncidentSchema), so before this fix they fell
  // through to the pod branch's `ns:default` fallback and got merged with genuinely
  // unrelated default-namespace pod incidents from ANY cluster.
  it('keeps a cluster-scoped incident out of the "ns:default" bucket, scoped per cluster', () => {
    const key = OrchestratorAgent._dispatchKey({ scope: 'cluster', clusterName: 'cluster-a', type: 'HPAFailure' });
    expect(key).toBe('cluster:cluster-a');
    expect(key).not.toBe('ns:default');
  });

  it('scopes cluster-scoped incidents to different keys across clusters, even with the same type', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'cluster', clusterName: 'cluster-a', type: 'HPAFailure' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'cluster', clusterName: 'cluster-b', type: 'HPAFailure' });
    expect(a).not.toBe(b);
  });

  // §Fix-ClusterKeyFragmentation (2026-09-04) — `type` is freeform LLM text, not a
  // stable identifier: the same recurring cluster-wide problem was regularly getting a
  // DIFFERENT dispatch key almost every cycle (control_plane_unhealthy vs
  // control_plane_degraded vs apiserver_failure, etc.), so cooldown/dedup never caught
  // it and the queue kept accumulating near-duplicate entries for one real issue.
  it('groups DIFFERENT types on the SAME cluster under the SAME key — the fix for type-wording fragmentation', () => {
    const a = OrchestratorAgent._dispatchKey({ scope: 'cluster', clusterName: 'cluster-a', type: 'control_plane_unhealthy' });
    const b = OrchestratorAgent._dispatchKey({ scope: 'cluster', clusterName: 'cluster-a', type: 'control_plane_degraded' });
    expect(a).toBe(b);
  });
});

describe('_findClusterMismatches', () => {
  const signals = {
    pods: [
      { name: 'api-1', namespace: 'payments', ownerName: 'api', clusterName: 'cluster-a' },
      { name: 'api-2', namespace: 'payments', ownerName: 'api', clusterName: 'cluster-b' },
    ],
    nodes: [{ name: 'worker-1', clusterName: 'cluster-a' }],
  };

  it('finds no mismatch when the claimed clusterName matches ground truth', () => {
    const incidents = [{ scope: 'pod', namespace: 'payments', podName: 'api-1', clusterName: 'cluster-a' }];
    expect(OrchestratorAgent._findClusterMismatches(incidents, signals)).toEqual([]);
  });

  it('corrects a pod-scoped incident attributed to the wrong cluster', () => {
    const incidents = [{ scope: 'pod', namespace: 'payments', podName: 'api-1', clusterName: 'cluster-b' }];
    const problems = OrchestratorAgent._findClusterMismatches(incidents, signals);
    expect(problems).toEqual([{ index: 0, correctClusterName: 'cluster-a', claimed: 'cluster-b' }]);
  });

  it('corrects a node-scoped incident attributed to the wrong cluster', () => {
    const incidents = [{ scope: 'node', nodeName: 'worker-1', clusterName: 'cluster-b' }];
    const problems = OrchestratorAgent._findClusterMismatches(incidents, signals);
    expect(problems).toEqual([{ index: 0, correctClusterName: 'cluster-a', claimed: 'cluster-b' }]);
  });

  it('falls back to matching a deployment-owned pod when podName is absent', () => {
    const incidents = [{ scope: 'pod', namespace: 'payments', deployment: 'api', clusterName: 'cluster-b' }];
    const problems = OrchestratorAgent._findClusterMismatches(incidents, signals);
    // ambiguous by deployment alone (two clusters both own "api") — first match wins,
    // so this only asserts it doesn't crash and returns a well-formed result.
    expect(Array.isArray(problems)).toBe(true);
  });

  it('leaves scope "cluster" incidents alone — no ground truth to check them against', () => {
    const incidents = [{ scope: 'cluster', clusterName: 'cluster-b', evidenceSummary: 'HPA controller down' }];
    expect(OrchestratorAgent._findClusterMismatches(incidents, signals)).toEqual([]);
  });
});

describe('_findMissingDeployments (§Fix-DeploymentBackfill)', () => {
  const signals = {
    pods: [
      { name: 'p2-oom-8fdcc66f6-rw59m', namespace: 'kubepilot-bench', clusterName: 'minikube', ownerKind: 'ReplicaSet', ownerName: 'p2-oom-8fdcc66f6' },
      { name: 'p5-bare-pod',            namespace: 'kubepilot-bench', clusterName: 'minikube', ownerKind: null,          ownerName: null },
    ],
  };

  // Regression test — found live 2026-09-04: the classifier satisfied PodIncidentSchema's
  // "podName OR deployment" requirement with podName alone, so the SAME Deployment ended
  // up tracked under five different resource identities (one per pod recreation) because
  // issueKey/resource fall back to podName whenever deployment is null.
  it('backfills deployment from a ReplicaSet-owned pod, stripping the pod-template-hash suffix', () => {
    const incidents = [{ scope: 'pod', namespace: 'kubepilot-bench', podName: 'p2-oom-8fdcc66f6-rw59m', clusterName: 'minikube', deployment: null }];
    const fixes = OrchestratorAgent._findMissingDeployments(incidents, signals);
    expect(fixes).toEqual([{ index: 0, deployment: 'p2-oom' }]);
  });

  it('does nothing when deployment is already set', () => {
    const incidents = [{ scope: 'pod', namespace: 'kubepilot-bench', podName: 'p2-oom-8fdcc66f6-rw59m', clusterName: 'minikube', deployment: 'p2-oom' }];
    expect(OrchestratorAgent._findMissingDeployments(incidents, signals)).toEqual([]);
  });

  it('does nothing for a bare pod with no owner', () => {
    const incidents = [{ scope: 'pod', namespace: 'kubepilot-bench', podName: 'p5-bare-pod', clusterName: 'minikube', deployment: null }];
    expect(OrchestratorAgent._findMissingDeployments(incidents, signals)).toEqual([]);
  });

  it('leaves node/cluster-scoped incidents alone', () => {
    const incidents = [{ scope: 'node', nodeName: 'worker-1', clusterName: 'minikube' }];
    expect(OrchestratorAgent._findMissingDeployments(incidents, signals)).toEqual([]);
  });
});

describe('_annotateSiblingInfo (§Triage sibling pre-check)', () => {
  it('reports zero unhealthy siblings and managedByController when only one pod of a controller is unhealthy', () => {
    const pods = [
      { name: 'api-8fdcc66f6-rw59m', namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'api-8fdcc66f6' },
    ];
    const [annotated] = OrchestratorAgent._annotateSiblingInfo(pods);
    expect(annotated.managedByController).toBe(true);
    expect(annotated.controllerRef).toBe('deployment/api');
    expect(annotated.unhealthySiblings).toBe(0);
  });

  it('counts OTHER unhealthy pods sharing the same resolved controller, excluding itself', () => {
    const pods = [
      { name: 'api-abc123-x1', namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'api-abc123' },
      { name: 'api-abc123-x2', namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'api-abc123' },
      { name: 'api-abc123-x3', namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'api-abc123' },
    ];
    const annotated = OrchestratorAgent._annotateSiblingInfo(pods);
    annotated.forEach(p => expect(p.unhealthySiblings).toBe(2));
  });

  it('does not count pods owned by a DIFFERENT controller as siblings', () => {
    const pods = [
      { name: 'api-abc-x1',   namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'api-abc' },
      { name: 'cache-def-x1', namespace: 'payments', clusterName: 'prod', ownerKind: 'ReplicaSet', ownerName: 'cache-def' },
    ];
    const annotated = OrchestratorAgent._annotateSiblingInfo(pods);
    annotated.forEach(p => expect(p.unhealthySiblings).toBe(0));
  });

  it('does not count same-named owners across DIFFERENT clusters or namespaces as siblings', () => {
    const pods = [
      { name: 'api-abc-x1', namespace: 'payments', clusterName: 'cluster-a', ownerKind: 'ReplicaSet', ownerName: 'api-abc' },
      { name: 'api-abc-x2', namespace: 'payments', clusterName: 'cluster-b', ownerKind: 'ReplicaSet', ownerName: 'api-abc' },
    ];
    const annotated = OrchestratorAgent._annotateSiblingInfo(pods);
    annotated.forEach(p => expect(p.unhealthySiblings).toBe(0));
  });

  it('marks a bare pod (no ownerReferences) as not managed by a controller, with zero siblings', () => {
    const pods = [{ name: 'debug-pod', namespace: 'default', clusterName: 'prod', ownerKind: null, ownerName: null }];
    const [annotated] = OrchestratorAgent._annotateSiblingInfo(pods);
    expect(annotated.managedByController).toBe(false);
    expect(annotated.controllerRef).toBeNull();
    expect(annotated.unhealthySiblings).toBe(0);
  });

  it('treats StatefulSet/DaemonSet ownership directly, with no hash-suffix stripping', () => {
    const pods = [{ name: 'db-0', namespace: 'payments', clusterName: 'prod', ownerKind: 'StatefulSet', ownerName: 'db' }];
    const [annotated] = OrchestratorAgent._annotateSiblingInfo(pods);
    expect(annotated.controllerRef).toBe('statefulset/db');
  });
});

describe('_findOvercalledSimple (§Triage deterministic complexity backstop)', () => {
  const annotatedPods = [
    { name: 'lone-abc-x1', namespace: 'payments', clusterName: 'prod', managedByController: true, controllerRef: 'deployment/lone', unhealthySiblings: 0 },
    { name: 'busy-abc-x1', namespace: 'payments', clusterName: 'prod', managedByController: true, controllerRef: 'deployment/busy', unhealthySiblings: 2 },
    { name: 'busy-abc-x2', namespace: 'payments', clusterName: 'prod', managedByController: true, controllerRef: 'deployment/busy', unhealthySiblings: 2 },
    { name: 'bare-pod',    namespace: 'payments', clusterName: 'prod', managedByController: false, controllerRef: null, unhealthySiblings: 0 },
  ];

  it('leaves a SIMPLE call alone when the pod truly has zero unhealthy siblings and a controller', () => {
    const incidents = [{ scope: 'pod', clusterName: 'prod', namespace: 'payments', podName: 'lone-abc-x1', complexity: 'SIMPLE' }];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([]);
  });

  it('forces COMPLEX when the model called SIMPLE but the pod has unhealthy siblings', () => {
    const incidents = [{ scope: 'pod', clusterName: 'prod', namespace: 'payments', podName: 'busy-abc-x1', complexity: 'SIMPLE' }];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([0]);
  });

  it('forces COMPLEX when the model called SIMPLE on a bare pod with no controller', () => {
    const incidents = [{ scope: 'pod', clusterName: 'prod', namespace: 'payments', podName: 'bare-pod', complexity: 'SIMPLE' }];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([0]);
  });

  it('forces COMPLEX for a node-scoped incident regardless of what the model claimed', () => {
    const incidents = [{ scope: 'node', clusterName: 'prod', nodeName: 'worker-1', complexity: 'SIMPLE' }];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([0]);
  });

  it('leaves a COMPLEX/UNKNOWN call untouched — the gate only ever downgrades SIMPLE', () => {
    const incidents = [
      { scope: 'pod', clusterName: 'prod', namespace: 'payments', podName: 'busy-abc-x1', complexity: 'COMPLEX' },
      { scope: 'node', clusterName: 'prod', nodeName: 'worker-1', complexity: 'UNKNOWN' },
    ];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([]);
  });

  it('resolves a deployment-only incident (no podName) via the owning controller match', () => {
    const incidents = [{ scope: 'pod', clusterName: 'prod', namespace: 'payments', deployment: 'lone', podName: null, complexity: 'SIMPLE' }];
    expect(OrchestratorAgent._findOvercalledSimple(incidents, annotatedPods)).toEqual([]);
  });
});

describe('_computeGroupPriorities', () => {
  it('assigns a single incident its own severity score', () => {
    const survivors = [{ incident: { severity: 'high' }, dispatchKey: 'ns:c:payments' }];
    expect(OrchestratorAgent._computeGroupPriorities(survivors).get('ns:c:payments')).toBe(3);
  });

  it('takes the HIGHEST severity among incidents sharing a dispatch key', () => {
    const survivors = [
      { incident: { severity: 'low' },      dispatchKey: 'ns:c:payments' },
      { incident: { severity: 'critical' }, dispatchKey: 'ns:c:payments' },
      { incident: { severity: 'medium' },   dispatchKey: 'ns:c:payments' },
    ];
    expect(OrchestratorAgent._computeGroupPriorities(survivors).get('ns:c:payments')).toBe(4);
  });

  it('keeps different dispatch keys in independent groups', () => {
    const survivors = [
      { incident: { severity: 'critical' }, dispatchKey: 'ns:c:payments' },
      { incident: { severity: 'low' },      dispatchKey: 'ns:c:checkout' },
    ];
    const priorities = OrchestratorAgent._computeGroupPriorities(survivors);
    expect(priorities.get('ns:c:payments')).toBe(4);
    expect(priorities.get('ns:c:checkout')).toBe(1);
  });

  it('defaults an unrecognized severity to the lowest priority', () => {
    const survivors = [{ incident: { severity: 'unknown' }, dispatchKey: 'node:n1' }];
    expect(OrchestratorAgent._computeGroupPriorities(survivors).get('node:n1')).toBe(1);
  });
});

describe('_summarizePods', () => {
  const basePod = (overrides = {}) => ({
    metadata: { name: 'api-7f9', namespace: 'payments', ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7f9' }] },
    spec: { nodeName: 'node-1' },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'api', ready: true, restartCount: 0 }],
    },
    ...overrides,
  });

  it('drops healthy Running pods with no bad containers', () => {
    expect(OrchestratorAgent._summarizePods({ items: [basePod()] })).toEqual([]);
  });

  it('keeps a pod whose container is crash-looping', () => {
    const pod = basePod({
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: 'api', ready: false, restartCount: 7,
          state: { waiting: { reason: 'CrashLoopBackOff' } },
        }],
      },
    });
    const [summary] = OrchestratorAgent._summarizePods({ items: [pod] });
    expect(summary.name).toBe('api-7f9');
    expect(summary.containers[0].restartCount).toBe(7);
    expect(summary.containers[0].waitingReason).toBe('CrashLoopBackOff');
  });

  it('keeps a pod that is not Running even with no bad container flags', () => {
    const pod = basePod({ status: { phase: 'Pending', containerStatuses: [] } });
    expect(OrchestratorAgent._summarizePods({ items: [pod] })).toHaveLength(1);
  });
});

describe('_summarizeNodes', () => {
  it('always keeps the Ready condition and keeps only non-False other conditions', () => {
    const node = {
      metadata: { name: 'node-1' },
      spec: { unschedulable: false, taints: [] },
      status: {
        conditions: [
          { type: 'Ready',          status: 'True'  },
          { type: 'DiskPressure',   status: 'False' }, // healthy — dropped
          { type: 'MemoryPressure', status: 'True'  }, // abnormal — kept
        ],
      },
    };
    const [summary] = OrchestratorAgent._summarizeNodes({ items: [node] });
    const types = summary.conditions.map(c => c.type);
    expect(types).toContain('Ready');
    expect(types).toContain('MemoryPressure');
    expect(types).not.toContain('DiskPressure');
  });
});

describe('_summarizeEvents', () => {
  it('keeps only Warning events', () => {
    const events = {
      items: [
        { type: 'Normal',  reason: 'Scheduled', involvedObject: {} },
        { type: 'Warning', reason: 'BackOff',   involvedObject: {} },
      ],
    };
    const summary = OrchestratorAgent._summarizeEvents(events);
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toBe('BackOff');
  });
});
