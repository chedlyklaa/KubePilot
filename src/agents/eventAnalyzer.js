'use strict';

const { loadConfig } = require('../config');

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

const _config = loadConfig();

const EVENT_MAX_AGE_MS = _config.EVENT_MAX_AGE_MS;
const EVENT_MIN_COUNT        = _config.EVENT_MIN_COUNT;
const EVENT_RECENT_WINDOW_MS = _config.EVENT_RECENT_WINDOW_MS;

class EventAnalyzer {
  // Parse and classify Kubernetes events
  static extractEvents(eventsData) {
    const now    = Date.now();
    const cutoff = now - EVENT_MAX_AGE_MS;
    const events = [];

    for (const ev of eventsData.items ?? []) {
      if (ev.type === 'Normal') continue;

      const lastSeen = new Date(ev.lastTimestamp || ev.eventTime || 0).getTime();
      if (lastSeen < cutoff) continue;

      const count = ev.count ?? 1;
      const isRecent = (now - lastSeen) < EVENT_RECENT_WINDOW_MS;
      if (count < EVENT_MIN_COUNT && !isRecent) continue;

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

    events.sort((a, b) => b.count - a.count);
    return events;
  }

  // Summarize events for the prompt
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

  // Filter events for a pod or node
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
