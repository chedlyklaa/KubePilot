'use strict';

// Event reason → structured category mapping
const REASON_CATEGORY = {
  FailedScheduling:        'scheduling',
  FailedMount:             'storage',
  FailedAttachVolume:      'storage',
  FailedDetachVolume:      'storage',
  FailedCreatePodSandBox:  'network',
  NetworkNotReady:         'network',
  NodeNotReady:            'node',
  NodeNotSchedulable:      'node',
  Evicted:                 'resource',
  Preempting:              'resource',
  OOMKilling:              'resource',
  BackOff:                 'crash',
  CrashLoopBackOff:        'crash',
  Failed:                  'image',
  ErrImagePull:            'image',
  ImagePullBackOff:        'image',
};

// Events older than this are ignored
const EVENT_MAX_AGE_MS = parseInt(process.env.EVENT_MAX_AGE_MS || String(30 * 60 * 1000), 10);

class EventAnalyzer {
  /**
   * Parse `kubectl get events -A -o json` output into structured classified events.
   *
   * @param {object} eventsData - Parsed JSON from kubectl
   * @returns {Array} structured events, sorted by count desc then by last timestamp
   */
  static extractEvents(eventsData) {
    const now    = Date.now();
    const cutoff = now - EVENT_MAX_AGE_MS;
    const events = [];

    for (const ev of eventsData.items ?? []) {
      if (ev.type === 'Normal') continue; // only Warning events matter for remediation

      const lastSeen = new Date(ev.lastTimestamp || ev.eventTime || 0).getTime();
      if (lastSeen < cutoff) continue;

      const reason    = ev.reason ?? 'Unknown';
      const category  = REASON_CATEGORY[reason] ?? 'other';
      const involvedObj = ev.involvedObject ?? {};

      events.push({
        category,
        reason,
        message:   ev.message   ?? '',
        count:     ev.count     ?? 1,
        namespace: ev.namespace ?? involvedObj.namespace ?? 'default',
        kind:      involvedObj.kind   ?? 'Unknown',
        name:      involvedObj.name   ?? 'unknown',
        nodeName:  ev.source?.host   ?? null,
        lastSeen:  new Date(lastSeen).toISOString(),
        firstSeen: ev.firstTimestamp
          ? new Date(ev.firstTimestamp).toISOString()
          : null,
      });
    }

    // Sort by count descending (most frequent first)
    events.sort((a, b) => b.count - a.count);
    return events;
  }

  /**
   * Return a compact text summary of events for LLM prompt injection.
   * Groups by category and limits total tokens.
   *
   * @param {Array}  events
   * @param {number} maxItems - max events per category
   */
  static summarize(events, maxItems = 5) {
    if (!events.length) return '';
    const byCategory = {};
    for (const e of events) {
      if (!byCategory[e.category]) byCategory[e.category] = [];
      if (byCategory[e.category].length < maxItems)
        byCategory[e.category].push(e);
    }

    const lines = ['\nKUBERNETES EVENTS (Warning, last 30 min)'];
    for (const [cat, list] of Object.entries(byCategory)) {
      lines.push(`${cat.toUpperCase()}:`);
      for (const e of list) {
        lines.push(
          `  [${e.count}×] ${e.reason} — ${e.namespace}/${e.name}` +
          (e.nodeName ? ` (node: ${e.nodeName})` : '') +
          (e.message ? ` | ${e.message.slice(0, 120)}` : '')
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Filter events relevant to a specific pod or node.
   */
  static forTarget(events, { podName, namespace, nodeName } = {}) {
    return events.filter(e => {
      if (podName    && e.name      === podName    && e.namespace === namespace) return true;
      if (nodeName   && e.nodeName  === nodeName)                                return true;
      if (namespace  && e.namespace === namespace)                               return true;
      return false;
    });
  }
}

module.exports = EventAnalyzer;
