'use strict';

// ── Change-relevant Kubernetes event reasons (mostly Normal type — dropped by EventAnalyzer) ──
const DEPLOYMENT_CHANGE_REASONS = new Set([
  'ScalingReplicaSet',  // Deployment controller scaling RS — most reliable rollout signal
  'SuccessfulCreate',   // RS creating new pods during rollout
  'SuccessfulDelete',   // RS deleting old pods as rollout completes
  'DeploymentRollback', // Explicit kubectl rollout undo
  'RollingUpdate',      // Rolling update in progress
]);

const CONFIGMAP_SECRET_REASONS = new Set([
  'Updated',   // ConfigMap / Secret updated
  'Replaced',  // ConfigMap / Secret replaced
  'Created',   // ConfigMap / Secret created (new mount)
]);

// Correlation time windows (ms)
const WINDOWS = {
  HIGH:   5  * 60_000,  // ≤5 min  — strong signal
  MEDIUM: 15 * 60_000,  // ≤15 min — plausible signal
  LOW:    30 * 60_000,  // ≤30 min — weak signal; matches EventAnalyzer's max age
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// Extract change-event candidates from the raw Kubernetes EventList JSON.
// We read ALL event types here (not just Warning) because rollout events are Normal.
function extractChangeCandidates(eventsJson, issue, detectedAt) {
  const items = eventsJson?.items;
  if (!Array.isArray(items) || items.length === 0) return [];

  const ns         = issue.namespace ?? 'default';
  const deployment = issue.deployment ?? null;
  const detectedMs = detectedAt instanceof Date ? detectedAt.getTime() : Date.now();

  const candidates = [];

  for (const ev of items) {
    const reason = ev.reason ?? '';
    const kind   = ev.involvedObject?.kind ?? '';
    const evNs   = ev.involvedObject?.namespace ?? ev.metadata?.namespace ?? '';
    const evName = ev.involvedObject?.name ?? '';

    // Use firstTimestamp when available; fall back to lastTimestamp / eventTime
    const tsRaw = ev.firstTimestamp || ev.lastTimestamp || ev.eventTime;
    if (!tsRaw) continue;
    const tsMs = new Date(tsRaw).getTime();
    if (isNaN(tsMs)) continue;

    // Only events that occurred BEFORE the incident within the max window
    const deltaMs = detectedMs - tsMs;
    if (deltaMs < 0 || deltaMs > WINDOWS.LOW) continue;

    // ── Deployment / ReplicaSet rollout signals ──────────────────────────────
    if (DEPLOYMENT_CHANGE_REASONS.has(reason) &&
        (kind === 'Deployment' || kind === 'ReplicaSet' || kind === 'Pod')) {

      // Namespace must match (empty namespace = cluster-scoped, allow through)
      if (evNs && evNs !== ns) continue;

      // When we know the deployment, require the event to involve it or its RS
      if (deployment) {
        const nameMatch = evName === deployment ||
          evName.startsWith(deployment + '-') ||
          evName.startsWith(deployment + '_');
        if (!nameMatch) continue;
      }

      candidates.push({
        type:      'Deployment',
        reason,
        kind,
        name:      evName,
        namespace: evNs,
        tsMs,
        tsRaw,
        message:   ev.message ?? '',
      });
    }

    // ── ConfigMap / Secret change signals (best-effort) ──────────────────────
    if (CONFIGMAP_SECRET_REASONS.has(reason) &&
        (kind === 'ConfigMap' || kind === 'Secret')) {
      if (evNs && evNs !== ns) continue;
      candidates.push({
        type:      kind,
        reason,
        kind,
        name:      evName,
        namespace: evNs,
        tsMs,
        tsRaw,
        message:   ev.message ?? '',
      });
    }
  }

  // Sort closest-to-incident first so candidates[0] is the best temporal match
  candidates.sort((a, b) => b.tsMs - a.tsMs);
  return candidates;
}

// Parse the raw text from `kubectl rollout history` into a structured revision.
// Output: { revision: number, changeCause: string } for the latest revision, or null.
function parseRolloutHistory(text) {
  if (!text) return null;
  const entries = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('REVISION') && !l.startsWith('deployment.apps'))
    .map(l => { const m = l.match(/^(\d+)\s+(.*)/); return m ? { revision: parseInt(m[1], 10), changeCause: m[2].trim() } : null; })
    .filter(Boolean)
    .sort((a, b) => b.revision - a.revision);
  return entries[0] ?? null;
}

// Return true if the pod's node has active pressure conditions.
function hasNodePressure(nodeIssues) {
  return Array.isArray(nodeIssues) && nodeIssues.some(n =>
    ['NodeMemoryPressure', 'NodeDiskPressure', 'NodePIDPressure', 'NodeNotReady', 'NodeNetworkUnavailable'].includes(n.type)
  );
}

// ── Deterministic confidence scorer — zero LLM involvement ────────────────────
function scoreCandidate(candidate, { detectedAt, podMetrics, semanticMatches, nodeIssues, rolloutRevision }) {
  let score        = 0;
  const evidence   = [];
  const detectedMs = detectedAt instanceof Date ? detectedAt.getTime() : Date.now();
  const deltaMs    = detectedMs - candidate.tsMs;
  const deltaMin   = Math.round(deltaMs / 60_000);

  // Time-proximity signals (mutually exclusive; largest window that applies)
  if (deltaMs <= WINDOWS.HIGH) {
    score += 0.40;
    evidence.push(`${candidate.reason} on "${candidate.name}" occurred ${deltaMin}m before incident (≤5 min — strong correlation)`);
  } else if (deltaMs <= WINDOWS.MEDIUM) {
    score += 0.25;
    evidence.push(`${candidate.reason} on "${candidate.name}" occurred ${deltaMin}m before incident (≤15 min — plausible correlation)`);
  } else {
    score += 0.10;
    evidence.push(`${candidate.reason} on "${candidate.name}" occurred ${deltaMin}m before incident (≤30 min — weak correlation)`);
  }

  // Rollout history confirms active revision change
  if (rolloutRevision && rolloutRevision.changeCause && rolloutRevision.changeCause !== '<none>') {
    score += 0.15;
    evidence.push(`rollout history: revision ${rolloutRevision.revision} — "${rolloutRevision.changeCause}"`);
  }

  // Restart count elevated — consistent with a post-change regression
  if (podMetrics?.restarts?.count > 0) {
    score += 0.10;
    evidence.push(`restart count elevated (${podMetrics.restarts.count}) — consistent with post-change regression`);
  }

  // No node pressure — failure is isolated to the application layer
  if (!hasNodePressure(nodeIssues)) {
    score += 0.10;
    evidence.push('no node pressure detected — failure isolated to application/deployment layer');
  } else {
    // Node pressure is present — more likely infrastructure root cause
    score -= 0.15;
    evidence.push('node pressure detected — node conditions may be root cause; deployment change correlation weakened');
  }

  // Similar past incident in episodic memory reinforces the pattern
  if (semanticMatches?.length > 0) {
    const topScore = semanticMatches[0]?.score ?? 0;
    if (topScore > 0.70) {
      score += 0.10;
      evidence.push(`similar past incident in memory (similarity ${topScore.toFixed(2)}) — known failure pattern after deployment`);
    }
  }

  return {
    score:    Math.min(1.0, Math.max(0.0, score)),
    evidence,
  };
}

// ── ChangeCorrelationEngine ────────────────────────────────────────────────────

class ChangeCorrelationEngine {
  /**
   * Find the most likely Kubernetes change that triggered an incident.
   *
   * Safe-by-default: returns null on any error so the pipeline continues unchanged.
   * Gated by CHANGE_CORRELATION_ENABLED env flag.
   *
   * All input data is already collected by the ClusterAgent run cycle —
   * this method makes ZERO additional kubectl or database calls.
   *
   * @param {object} opts
   * @param {object} opts.issue            Pod issue object from PodAnalyzer
   * @param {Date}   opts.detectedAt       Moment the ClusterAgent cycle started
   * @param {object} opts.eventsJson       Raw Kubernetes EventList JSON (already fetched)
   * @param {object} opts.podMetrics       Prometheus pod metrics or null
   * @param {Array}  opts.semanticMatches  EpisodicMemory.findSemantic() hits
   * @param {Array}  opts.nodeIssues       NodeAnalyzer issues for this pod's node
   * @param {string} opts.rolloutHistory   Raw rollout history text (from _enrichEvidence, may be null)
   *
   * @returns {{ triggerType, triggerResource, triggerTimestamp, confidence, evidence[] } | null}
   */
  async correlate({
    issue,
    detectedAt,
    eventsJson,
    podMetrics       = null,
    semanticMatches  = [],
    nodeIssues       = [],
    rolloutHistory   = null,
  }) {
    if (process.env.CHANGE_CORRELATION_ENABLED !== 'true') return null;

    try {
      const safeDetectedAt = detectedAt instanceof Date ? detectedAt : new Date();

      const candidates      = extractChangeCandidates(eventsJson, issue, safeDetectedAt);
      const rolloutRevision = parseRolloutHistory(rolloutHistory);

      if (candidates.length === 0) {
        // No change events found in the correlation window for this deployment/namespace
        return null;
      }

      // Score the best temporal match (already sorted closest-first)
      const top = candidates[0];
      const { score, evidence } = scoreCandidate(top, {
        detectedAt:     safeDetectedAt,
        podMetrics,
        semanticMatches,
        nodeIssues,
        rolloutRevision,
      });

      // Confidence below 0.15 is too weak to be actionable — suppress
      if (score < 0.15) return null;

      // Build human-readable trigger label
      const changeCause = rolloutRevision?.changeCause && rolloutRevision.changeCause !== '<none>'
        ? rolloutRevision.changeCause
        : null;
      const triggerResource = changeCause
        ? `${top.name} @ ${changeCause}`
        : top.name;

      const result = {
        triggerType:      top.type,          // "Deployment" | "ConfigMap" | "Secret"
        triggerResource,                     // e.g. "checkout-6df @ image updated to v2.8.1"
        triggerTimestamp: top.tsRaw,         // ISO string from Kubernetes event
        confidence:       Math.round(score * 100) / 100,
        evidence,
      };

      return result;

    } catch (err) {
      console.warn(`[CHANGE_CORRELATION] Correlation failed (non-blocking): ${err.message}`);
      return null; // never let this block the main pipeline
    }
  }
}

module.exports = new ChangeCorrelationEngine();
