import { describe, it, expect, beforeAll } from 'vitest';
import yaml from 'js-yaml';
import { ToolMessage, AIMessage } from '@langchain/core/messages';

let cb;

beforeAll(async () => {
  ({ default: cb } = await import('./contextBudget.js'));
});

function noisyPod(name = 'api-7f9') {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      name, namespace: 'shop', uid: '3f2a9c1e-8b4d-4e21-9a77-0c5d2e6f1b88', resourceVersion: '184223',
      generation: 3, creationTimestamp: '2026-10-26T08:00:00Z', labels: { app: 'api' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7f9c' }],
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ spec: 'x'.repeat(1500) }),
        'prometheus.io/scrape': 'true',
      },
      managedFields: [{ manager: 'kubectl-client-side-apply', fieldsV1: { big: 'y'.repeat(2000) } }],
    },
    spec: { containers: [{ name: 'api', image: 'shop/api:1.4.2', resources: { limits: { memory: '256Mi' } } }] },
    status: { containerStatuses: [{ name: 'api', restartCount: 14, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] },
  };
}

describe('filterToolOutput', () => {
  it('removes managedFields, uid, resourceVersion and last-applied-configuration from -o json', () => {
    const out = cb.filterToolOutput('get pod api-7f9 -n shop -o json', JSON.stringify(noisyPod(), null, 4));
    const obj = JSON.parse(out);
    expect(obj.metadata.managedFields).toBeUndefined();
    expect(obj.metadata.uid).toBeUndefined();
    expect(obj.metadata.resourceVersion).toBeUndefined();
    expect(obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined();
  });

  it('keeps every diagnostic field: labels, other annotations, owners, generation, spec, status', () => {
    const obj = JSON.parse(cb.filterToolOutput('get pod api-7f9 -o json', JSON.stringify(noisyPod())));
    expect(obj.metadata.labels).toEqual({ app: 'api' });
    expect(obj.metadata.annotations).toEqual({ 'prometheus.io/scrape': 'true' });
    expect(obj.metadata.ownerReferences[0].name).toBe('api-7f9c');
    expect(obj.metadata.generation).toBe(3);
    expect(obj.metadata.creationTimestamp).toBe('2026-10-26T08:00:00Z');
    expect(obj.spec.containers[0].resources.limits.memory).toBe('256Mi');
    expect(obj.status.containerStatuses[0].lastState.terminated.reason).toBe('OOMKilled');
  });

  it('cleans every item of a List and keeps YAML output as YAML', () => {
    const list = { apiVersion: 'v1', kind: 'List', items: [noisyPod('a'), noisyPod('b')] };
    const out = cb.filterToolOutput('get pods -n shop -o yaml', yaml.dump(list));
    const obj = yaml.load(out);
    expect(obj.items).toHaveLength(2);
    expect(obj.items.every(p => p.metadata.managedFields === undefined)).toBe(true);
    expect(obj.items[1].status.containerStatuses[0].restartCount).toBe(14);
  });

  it('drops the annotations key entirely once only noise annotations were present', () => {
    const pod = noisyPod();
    delete pod.metadata.annotations['prometheus.io/scrape'];
    const obj = JSON.parse(cb.filterToolOutput('get pod api-7f9 --output=json', JSON.stringify(pod)));
    expect(obj.metadata.annotations).toBeUndefined();
  });

  it('shrinks a typical noisy pod enough to fit under the output cap untruncated', () => {
    const raw = JSON.stringify(noisyPod(), null, 4);
    expect(raw.length).toBeGreaterThan(cb.MAX_TOOL_OUTPUT_CHARS);
    expect(cb.filterToolOutput('get pod api-7f9 -o json', raw).length).toBeLessThan(cb.MAX_TOOL_OUTPUT_CHARS);
  });

  it('returns YAML byte-for-byte when there is nothing to strip, and never makes YAML larger', () => {
    const clean = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: a\nspec:\n  containers:\n  - image: x\n    name: a\n";
    expect(cb.filterToolOutput('get pod a -o yaml', clean)).toBe(clean);
    const withUid = clean.replace('  name: a\n', '  name: a\n  uid: 1\n');
    expect(cb.filterToolOutput('get pod a -o yaml', withUid).length).toBeLessThanOrEqual(withUid.length);
  });

  it('passes through non-structured output and unparseable output unchanged', () => {
    expect(cb.filterToolOutput('describe pod api-7f9', 'Name: api-7f9')).toBe('Name: api-7f9');
    expect(cb.filterToolOutput('get pods -o wide', 'NAME READY')).toBe('NAME READY');
    expect(cb.filterToolOutput('get pod x -o json', 'Warning: something\n{"a":1}')).toBe('Warning: something\n{"a":1}');
  });
});

describe('truncateToolOutput', () => {
  it('leaves output under the cap untouched', () => {
    expect(cb.truncateToolOutput('get pods', 'short')).toBe('short');
  });

  it('keeps head AND tail, so the end of describe (Events) survives', () => {
    const out = 'HEAD' + 'x'.repeat(10_000) + 'Warning BackOff restarting failed container';
    const t = cb.truncateToolOutput('describe pod api-7f9', out);
    expect(t.startsWith('HEAD')).toBe(true);
    expect(t.endsWith('Warning BackOff restarting failed container')).toBe(true);
    expect(t).toContain('chars truncated');
    expect(t.length).toBeLessThan(cb.MAX_TOOL_OUTPUT_CHARS + 100);
  });

  it('weights logs toward the tail, where the crash is', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const t = cb.truncateToolOutput('logs api-7f9 -n shop', lines);
    expect(t).toContain('line 1999');
    expect(t.split('...(')[1].length).toBeGreaterThan(3000);
  });
});

describe('withDefaultLogTail', () => {
  it('adds --tail to unbounded logs', () => {
    expect(cb.withDefaultLogTail('logs api-7f9 -n shop --previous')).toBe('logs api-7f9 -n shop --previous --tail=200');
  });

  it('respects a tail the model already chose, and never touches label-selector logs or other verbs', () => {
    expect(cb.withDefaultLogTail('logs api-7f9 --tail=50')).toBe('logs api-7f9 --tail=50');
    expect(cb.withDefaultLogTail('logs api-7f9 --tail 50')).toBe('logs api-7f9 --tail 50');
    expect(cb.withDefaultLogTail('logs -l app=api -n shop')).toBe('logs -l app=api -n shop');
    expect(cb.withDefaultLogTail('get pods -n shop')).toBe('get pods -n shop');
  });
});

describe('compactToolHistory', () => {
  const big = (n) => `RESULT-${n}-START ` + 'z'.repeat(3000) + ` RESULT-${n}-END`;

  function history(count) {
    const messages = [];
    for (let i = 0; i < count; i++) {
      messages.push(new AIMessage({ content: '', tool_calls: [{ id: `call_${i}`, name: 'run', args: {} }] }));
      messages.push(new ToolMessage({ content: big(i), tool_call_id: `call_${i}` }));
    }
    return messages;
  }

  it('does nothing below the trigger, so the prefix stays stable on early turns', () => {
    const messages = history(5);
    expect(cb.compactToolHistory(messages)).toBe(0);
    expect(messages.every(m => m.getType() !== 'tool' || m.content.length > 3000)).toBe(true);
  });

  it('at the trigger, compacts all but the newest 3 and keeps head + tail of each', () => {
    const messages = history(6);
    expect(cb.compactToolHistory(messages)).toBe(3);
    const tools = messages.filter(m => m.getType() === 'tool');
    expect(tools.slice(0, 3).every(m => m.content.length < 1000)).toBe(true);
    expect(tools.slice(3).every(m => m.content.length > 3000)).toBe(true);
    expect(tools[0].content).toContain('RESULT-0-START');
    expect(tools[0].content).toContain('RESULT-0-END');
  });

  it('never removes a message and keeps every tool_call_id paired', () => {
    const messages = history(8);
    const before = messages.map(m => m.tool_call_id ?? null);
    cb.compactToolHistory(messages);
    expect(messages).toHaveLength(16);
    expect(messages.map(m => m.tool_call_id ?? null)).toEqual(before);
  });

  it('is idempotent: already-compacted results are not compacted again', () => {
    const messages = history(6);
    cb.compactToolHistory(messages);
    const snapshot = messages.map(m => m.content);
    expect(cb.compactToolHistory(messages)).toBe(0);
    expect(messages.map(m => m.content)).toEqual(snapshot);
  });

  it('never touches short results such as errors', () => {
    const messages = history(6);
    messages.splice(1, 1, new ToolMessage({ content: 'ERROR: command blocked', tool_call_id: 'call_0' }));
    messages.push(new AIMessage({ content: '', tool_calls: [{ id: 'call_x', name: 'run', args: {} }] }));
    messages.push(new ToolMessage({ content: big('x'), tool_call_id: 'call_x' }));
    cb.compactToolHistory(messages);
    expect(messages[1].content).toBe('ERROR: command blocked');
  });
});
