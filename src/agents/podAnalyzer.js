// Extracts issues from pod data
class PodAnalyzer {
  static extractIssues(podsData) {
    const issues = [];

    for (const pod of podsData.items ?? []) {
      const podName   = pod.metadata?.name;
      const namespace = pod.metadata?.namespace ?? "default";
      const phase     = pod.status?.phase;

      const ownerRefs  = pod.metadata?.ownerReferences ?? [];
      const { deployment, ownerKind, controllerName } = PodAnalyzer._extractOwner(ownerRefs);

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
        if (waiting?.reason === "CrashLoopBackOff") {

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
            oomKilled:     isOOM,
            exitCode:      lastTerminated?.exitCode ?? null,
            message:       waiting.message ?? null,
          });
        }

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

        if (
          terminated &&
          terminated.reason !== "Completed" &&
          terminated.exitCode !== 0
        ) {
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

      const alreadyReported = issues.some((i) => i.podName === podName);
      const podReady = (pod.status?.conditions ?? []).find(
        (c) => c.type === "Ready"
      );

      const hasAnyStatuses =
        (pod.status?.containerStatuses     ?? []).length > 0 ||
        (pod.status?.initContainerStatuses ?? []).length > 0;
      const ageSecs = pod.metadata?.creationTimestamp
        ? (Date.now() - new Date(pod.metadata.creationTimestamp).getTime()) / 1000
        : 0;
      const stuckPending =
        phase === 'Pending' && !hasAnyStatuses && ageSecs > 60;

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