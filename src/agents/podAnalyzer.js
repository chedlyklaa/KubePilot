// src/agents/podAnalyzer.js  — patched sections
// Drop-in replacement for extractIssues()

class PodAnalyzer {
  static extractIssues(podsData) {
    const issues = [];

    for (const pod of podsData.items ?? []) {
      const podName   = pod.metadata?.name;
      const namespace = pod.metadata?.namespace ?? "default";
      const phase     = pod.status?.phase;

      // ── Skip pods that are fine ──────────────────────
      // Completed = Job/init container finished cleanly. Not an issue.
     
      const ownerRefs  = pod.metadata?.ownerReferences ?? [];
      const { deployment, ownerKind, controllerName } = PodAnalyzer._extractOwner(ownerRefs);

      // Startup grace period: skip pods younger than 30s that have no explicit
      // error state yet (still in Pending/ContainerCreating). This prevents
      // false positives during normal deployment rollouts.
      const podAgeSecs = pod.metadata?.creationTimestamp
        ? (Date.now() - new Date(pod.metadata.creationTimestamp).getTime()) / 1000
        : Infinity;
      const hasExplicitError = (pod.status?.containerStatuses ?? []).some(cs =>
        cs.state?.waiting?.reason === 'CrashLoopBackOff' ||
        cs.state?.waiting?.reason === 'ImagePullBackOff' ||
        cs.state?.waiting?.reason === 'ErrImagePull' ||
        cs.state?.terminated?.reason === 'OOMKilled' ||
        (cs.state?.terminated && cs.state.terminated.exitCode !== 0)
      );
      if (podAgeSecs < 30 && !hasExplicitError && phase !== 'Running') continue;

      for (const cs of pod.status?.containerStatuses ?? []) {
        const waiting    = cs.state?.waiting;
        const terminated = cs.state?.terminated;
         // ── CrashLoopBackOff ────────────────────────────
        if (waiting?.reason === "CrashLoopBackOff") {

          // Try to detect OOM: check lastState exit code 137
          // or reason "OOMKilled". 137 = SIGKILL from OOM killer.
          const lastTerminated = cs.lastState?.terminated;
          const isOOM =
            lastTerminated?.reason === "OOMKilled" ||
            lastTerminated?.exitCode === 137;

          issues.push({
            type:          "CrashLoopBackOff",
            podName,
            namespace,
            deployment, ownerKind, controllerName,
            containerName: cs.name,
            restartCount:  cs.restartCount,
            // Pass OOM signal explicitly so LLM/fix logic can use it
            oomKilled:     isOOM,
            exitCode:      lastTerminated?.exitCode ?? null,
            message:       waiting.message ?? null,
          });
        }

        // ── OOMKilled (not yet in backoff) ──────────────
        if (terminated?.reason === "OOMKilled") {
          issues.push({
            type:          "OOMKilled",
            podName,
            namespace,
            deployment, ownerKind, controllerName,
            containerName: cs.name,
            restartCount:  cs.restartCount,
            oomKilled:     true,
            exitCode:      137,
            message:       null,
          });
        }

        // ── Error / non-zero exit ───────────────────────
        // Only flag if it's NOT Completed (exit 0)
        if (
          terminated &&
          terminated.reason !== "Completed" &&
          terminated.exitCode !== 0
        ) {
          // Avoid double-reporting OOMKilled
          if (terminated.reason !== "OOMKilled") {
            issues.push({
              type:          "ContainerError",
              podName,
              namespace,
              deployment, ownerKind, controllerName,
              containerName: cs.name,
              exitCode:      terminated.exitCode,
              reason:        terminated.reason,
              message:       terminated.message ?? null,
            });
          }
        }

        // ── ImagePullBackOff ────────────────────────────
        if (
          waiting?.reason === "ImagePullBackOff" ||
          waiting?.reason === "ErrImagePull"
        ) {
          issues.push({
            type:          "ImagePullBackOff",
            podName,
            namespace,
            deployment, ownerKind, controllerName,
            containerName: cs.name,
            message:       waiting.message ?? null,
          });
        }
      }

      // ── Init container failures ─────────────────────────────────────────────
      // When an init container fails the main container never starts, so
      // containerStatuses is empty and the loop above finds nothing.
      // Read initContainerStatuses directly to surface those crashes.
      for (const ics of pod.status?.initContainerStatuses ?? []) {
        if (issues.some(i => i.podName === podName)) break;

        const iWaiting    = ics.state?.waiting;
        const iTerminated = ics.state?.terminated;

        if (iWaiting?.reason === 'CrashLoopBackOff') {
          const lastT = ics.lastState?.terminated;
          issues.push({
            type:          'CrashLoopBackOff',
            podName,
            namespace,
            deployment, ownerKind, controllerName,
            containerName: ics.name,
            initContainer: true,
            restartCount:  ics.restartCount,
            oomKilled:     lastT?.reason === 'OOMKilled' || lastT?.exitCode === 137,
            exitCode:      lastT?.exitCode ?? null,
            message:       iWaiting.message ?? null,
          });
        } else if (iTerminated && iTerminated.reason !== 'Completed' && iTerminated.exitCode !== 0) {
          if (iTerminated.reason !== 'OOMKilled') {
            issues.push({
              type:          'ContainerError',
              podName,
              namespace,
              deployment, ownerKind, controllerName,
              containerName: ics.name,
              initContainer: true,
              exitCode:      iTerminated.exitCode,
              reason:        iTerminated.reason,
              message:       iTerminated.message ?? null,
            });
          }
        }
      }

      // ── PodNotReady (catch-all) ─────────────────────────────────────────────
      // Only emit if phase is not Running AND no more specific issue was already
      // recorded for this pod.
      const alreadyReported = issues.some((i) => i.podName === podName);
      const podReady = (pod.status?.conditions ?? []).find(
        (c) => c.type === "Ready"
      );

      // Pods stuck in Pending with no container activity at all — this happens
      // when a Secret/ConfigMap volume can't be mounted. Kubernetes sets no Ready
      // condition until containers actually try to start, so podReady is undefined
      // and the Ready=False check below never fires. Guard with a 60s age threshold
      // so normally-starting pods aren't flagged mid-launch.
      const hasAnyStatuses =
        (pod.status?.containerStatuses     ?? []).length > 0 ||
        (pod.status?.initContainerStatuses ?? []).length > 0;
      const ageSecs = pod.metadata?.creationTimestamp
        ? (Date.now() - new Date(pod.metadata.creationTimestamp).getTime()) / 1000
        : 0;
      const stuckPending =
        phase === 'Pending' && !hasAnyStatuses && ageSecs > 60;

      // ── Unschedulable / FailedScheduling ─────────────────────────────────
      // Detect pods stuck in Pending with impossible resource requests or
      // scheduling constraints. These will never start without human intervention.
      if (
        !alreadyReported &&
        phase === 'Pending' &&
        !hasAnyStatuses &&
        ageSecs > 45
      ) {
        const conditions = pod.status?.conditions ?? [];
        const unschedulable = conditions.find(c =>
          c.type === 'PodScheduled' && c.status === 'False' &&
          (c.reason === 'Unschedulable' || c.reason === 'FailedScheduling')
        );
        if (unschedulable) {
          issues.push({
            type:       'Unschedulable',
            podName,
            namespace,
            deployment, ownerKind, controllerName,
            reason:     unschedulable.reason,
            message:    unschedulable.message ?? 'Pod cannot be scheduled — insufficient resources or constraints',
          });
        }
      }

      const alreadyReported2 = issues.some((i) => i.podName === podName);

      if (
        !alreadyReported2 &&
        phase !== "Succeeded" &&
        phase !== "Running" &&
        (podReady?.status === "False" || stuckPending)
      ) {
        issues.push({
          type:       "PodNotReady",
          podName,
          namespace,
          deployment, ownerKind, controllerName,
          reason:     podReady?.reason  ?? (stuckPending ? 'Pending'  : 'Unknown'),
          message:    podReady?.message ?? (stuckPending
            ? 'Pod stuck in Pending with no container activity — possible missing Secret, ConfigMap, or volume'
            : null),
        });
      }
    }

    return issues;
  }

  static _extractOwner(ownerRefs) {
    if (!ownerRefs?.length) return { deployment: null, ownerKind: null, controllerName: null };

    const owner = ownerRefs[0];
    const kind = owner.kind;
    const name = owner.name;

    if (kind === 'ReplicaSet') {
      const depName = name.replace(/-[a-z0-9]+$/, '') || null;
      return { deployment: depName, ownerKind: 'Deployment', controllerName: depName };
    }
    if (kind === 'StatefulSet') {
      return { deployment: null, ownerKind: 'StatefulSet', controllerName: name };
    }
    if (kind === 'DaemonSet') {
      return { deployment: null, ownerKind: 'DaemonSet', controllerName: name };
    }
    if (kind === 'Job') {
      return { deployment: null, ownerKind: 'Job', controllerName: name };
    }
    return { deployment: null, ownerKind: kind, controllerName: name };
  }
}

module.exports = PodAnalyzer;