import { describe, it, expect } from 'vitest';
import {
  CONDITION_TO_ISSUE_TYPE, NODE_RESOURCE_PRESSURE_TYPES, NODE_UNHEALTHY_TYPES,
} from './nodeConditions.js';

describe('nodeConditions', () => {
  it('maps every raw kubectl condition type to its NodeAnalyzer issue type', () => {
    expect(CONDITION_TO_ISSUE_TYPE).toEqual({
      MemoryPressure:     'NodeMemoryPressure',
      DiskPressure:       'NodeDiskPressure',
      PIDPressure:        'NodePIDPressure',
      NetworkUnavailable: 'NodeNetworkUnavailable',
    });
  });

  it('NODE_RESOURCE_PRESSURE_TYPES matches clusterAnalyzer\'s original hand-maintained set', () => {
    expect([...NODE_RESOURCE_PRESSURE_TYPES].sort()).toEqual(
      ['NodeDiskPressure', 'NodeMemoryPressure', 'NodePIDPressure'].sort()
    );
  });

  it('NODE_RESOURCE_PRESSURE_TYPES excludes NodeNetworkUnavailable (counted separately)', () => {
    expect(NODE_RESOURCE_PRESSURE_TYPES).not.toContain('NodeNetworkUnavailable');
  });

  it('NODE_UNHEALTHY_TYPES matches changeCorrelationEngine\'s original hand-maintained set', () => {
    expect([...NODE_UNHEALTHY_TYPES].sort()).toEqual(
      ['NodeDiskPressure', 'NodeMemoryPressure', 'NodeNetworkUnavailable', 'NodeNotReady', 'NodePIDPressure'].sort()
    );
  });

  it('NODE_UNHEALTHY_TYPES is a superset of NODE_RESOURCE_PRESSURE_TYPES', () => {
    for (const t of NODE_RESOURCE_PRESSURE_TYPES) expect(NODE_UNHEALTHY_TYPES).toContain(t);
  });

  it('exported arrays are frozen (accidental mutation at a call site cannot cause cross-file drift)', () => {
    expect(Object.isFrozen(NODE_RESOURCE_PRESSURE_TYPES)).toBe(true);
    expect(Object.isFrozen(NODE_UNHEALTHY_TYPES)).toBe(true);
    expect(Object.isFrozen(CONDITION_TO_ISSUE_TYPE)).toBe(true);
  });
});
