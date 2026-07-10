'use strict';

// Single source of truth for the Kubernetes node-condition taxonomy — previously
// hand-duplicated with drifting membership across nodeAnalyzer.js, clusterAnalyzer.js,
// and changeCorrelationEngine.js.

// Raw kubectl node condition type → the issue `type` NodeAnalyzer emits when that
// condition is True.
const CONDITION_TO_ISSUE_TYPE = Object.freeze({
  MemoryPressure:     'NodeMemoryPressure',
  DiskPressure:       'NodeDiskPressure',
  PIDPressure:        'NodePIDPressure',
  NetworkUnavailable: 'NodeNetworkUnavailable',
});

// Pure resource-exhaustion issue types (memory/disk/pid). Deliberately excludes
// NodeNetworkUnavailable — clusterAnalyzer counts NotReady nodes separately from
// "under pressure" nodes so a single node isn't double-counted across both tallies.
const NODE_RESOURCE_PRESSURE_TYPES = Object.freeze(
  Object.values(CONDITION_TO_ISSUE_TYPE).filter(t => t !== 'NodeNetworkUnavailable')
);

// "This node has some kind of active problem" — the broader set changeCorrelationEngine
// uses to decide whether a pod failure might be explained by its node's health rather
// than a recent deployment change. Resource-pressure types plus NotReady/NetworkUnavailable.
const NODE_UNHEALTHY_TYPES = Object.freeze([
  ...NODE_RESOURCE_PRESSURE_TYPES,
  'NodeNotReady',
  'NodeNetworkUnavailable',
]);

module.exports = { CONDITION_TO_ISSUE_TYPE, NODE_RESOURCE_PRESSURE_TYPES, NODE_UNHEALTHY_TYPES };
