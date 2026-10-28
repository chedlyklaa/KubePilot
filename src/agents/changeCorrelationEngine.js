'use strict';

const { NODE_UNHEALTHY_TYPES } = require('./nodeConditions');

const DEPLOYMENT_CHANGE_REASONS = new Set([
  'ScalingReplicaSet',
  'SuccessfulCreate',
  'SuccessfulDelete',
  'DeploymentRollback',
  'RollingUpdate',
]);

const CONFIGMAP_SECRET_REASONS = new Set([
  'Updated',
  'Replaced',
  'Created',
]);

const WINDOWS = {
  HIGH:   5  * 60_000,
  MEDIUM: 15 * 60_000,
  LOW:    30 * 60_000,
};

// Extract change candidates from events
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

    const tsRaw = ev.firstTimestamp || ev.lastTimestamp || ev.eventTime;
    if (!tsRaw) continue;
    const tsMs = new Date(tsRaw).getTime();
    if (isNaN(tsMs)) continue;

    const deltaMs = detectedMs - tsMs;
    if (deltaMs < 0 || deltaMs > WINDOWS.LOW) continue;

    if (DEPLOYMENT_CHANGE_REASONS.has(reason) &&
        (kind === 'Deployment' || kind === 'ReplicaSet' || kind === 'Pod')) {

      if (evNs && evNs !== ns) continue;

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

  candidates.sort((a, b) => b.tsMs - a.tsMs);
  return candidates;
}

// Parse rollout history output
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

// Check if the pod's node has pressure
function hasNodePressure(nodeIssues) {
  return Array.isArray(nodeIssues) && nodeIssues.some(n => NODE_UNHEALTHY_TYPES.includes(n.type));
}

// Score a change candidate
function scoreCandidate(candidate, { detectedAt, podMetrics, semanticMatches, nodeIssues, rolloutRevision }) {
  let score        = 0;
  const evidence   = [];
  const detectedMs = detectedAt instanceof Date ? detectedAt.getTime() : Date.now();
  const deltaMs    = detectedMs - candidate.tsMs;
  const deltaMin   = Math.round(deltaMs / 60_000);

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

  if (rolloutRevision && rolloutRevision.changeCause && rolloutRevision.changeCause !== '<none>') {
    score += 0.15;
    evidence.push(`rollout history: revision ${rolloutRevision.revision} — "${rolloutRevision.changeCause}"`);
  }

  if (podMetrics?.restarts?.count > 0) {
    score += 0.10;
    evidence.push(`restart count elevated (${podMetrics.restarts.count}) — consistent with post-change regression`);
  }

  if (!hasNodePressure(nodeIssues)) {
    score += 0.10;
    evidence.push('no node pressure detected — failure isolated to application/deployment layer');
  } else {
    score -= 0.15;
    evidence.push('node pressure detected — node conditions may be root cause; deployment change correlation weakened');
  }

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

// Finds the change that likely caused an incident
class ChangeCorrelationEngine {
  // Find the change most likely behind an incident
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
        return null;
      }

      const top = candidates[0];
      const { score, evidence } = scoreCandidate(top, {
        detectedAt:     safeDetectedAt,
        podMetrics,
        semanticMatches,
        nodeIssues,
        rolloutRevision,
      });

      if (score < 0.15) return null;

      const changeCause = rolloutRevision?.changeCause && rolloutRevision.changeCause !== '<none>'
        ? rolloutRevision.changeCause
        : null;
      const triggerResource = changeCause
        ? `${top.name} @ ${changeCause}`
        : top.name;

      const result = {
        triggerType:      top.type,
        triggerResource,
        triggerTimestamp: top.tsRaw,
        confidence:       Math.round(score * 100) / 100,
        evidence,
      };

      return result;

    } catch (err) {
      console.warn(`[CHANGE_CORRELATION] Correlation failed (non-blocking): ${err.message}`);
      return null;
    }
  }
}

module.exports = new ChangeCorrelationEngine();
