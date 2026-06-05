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
      const replicaSet = ownerRefs.find((r) => r.kind === "ReplicaSet");
      const deployment = replicaSet
        ? PodAnalyzer._deploymentFromReplicaSet(replicaSet.name)
        : null; // bare pod — no deployment

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
            deployment,    // may be null for bare pods
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
            deployment,
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
              deployment,
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
            deployment,
            containerName: cs.name,
            message:       waiting.message ?? null,
          });
        }
      }

      // ── PodNotReady (catch-all) ─────────────────────
      // Only emit if phase is not Running AND no more specific
      // issue was already recorded for this pod.
      const alreadyReported = issues.some((i) => i.podName === podName);
      const podReady = (pod.status?.conditions ?? []).find(
        (c) => c.type === "Ready"
      );

      if (
        !alreadyReported &&
        phase !== "Succeeded" &&
        phase !== "Running" &&
        podReady?.status === "False"
      ) {
        issues.push({
          type:       "PodNotReady",
          podName,
          namespace,
          deployment, // may be null
          reason:     podReady.reason ?? "Unknown",
          message:    podReady.message ?? null,
        });
      }
    }

    return issues;
  }

  // "my-deployment-6c8fb8d957" → "my-deployment"
  // Strips the last ReplicaSet hash (10 hex chars).
  static _deploymentFromReplicaSet(rsName) {
    // Strip the trailing pod-template-hash segment (variable length hex)
    return rsName.replace(/-[a-z0-9]+$/, '') || null;
  }
}

module.exports = PodAnalyzer;