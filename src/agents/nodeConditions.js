'use strict';

const CONDITION_TO_ISSUE_TYPE = Object.freeze({
  MemoryPressure:     'NodeMemoryPressure',
  DiskPressure:       'NodeDiskPressure',
  PIDPressure:        'NodePIDPressure',
  NetworkUnavailable: 'NodeNetworkUnavailable',
});

const NODE_RESOURCE_PRESSURE_TYPES = Object.freeze(
  Object.values(CONDITION_TO_ISSUE_TYPE).filter(t => t !== 'NodeNetworkUnavailable')
);

const NODE_UNHEALTHY_TYPES = Object.freeze([
  ...NODE_RESOURCE_PRESSURE_TYPES,
  'NodeNotReady',
  'NodeNetworkUnavailable',
]);

module.exports = { CONDITION_TO_ISSUE_TYPE, NODE_RESOURCE_PRESSURE_TYPES, NODE_UNHEALTHY_TYPES };
