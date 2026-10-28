import { describe, it, expect, beforeAll } from 'vitest';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

let investigator;

beforeAll(async () => {
  ({ default: investigator } = await import('./investigator.js'));
});

describe('_isReadOnlyCommand — Secret-value block', () => {
  it('blocks a bare "get secrets" command', () => {
    expect(investigator._isReadOnlyCommand('get secrets -n kube-system').ok).toBe(false);
  });

  it('blocks "secrets" even when a flag+value comes first in the command', () => {
    expect(investigator._isReadOnlyCommand('get -n kube-system secrets -o json').ok).toBe(false);
  });

  it('blocks "describe secret/foo"', () => {
    expect(investigator._isReadOnlyCommand('describe secret/foo -n default').ok).toBe(false);
  });

  it('blocks a comma-joined resource list containing secrets', () => {
    expect(investigator._isReadOnlyCommand('get pods,secrets -n default').ok).toBe(false);
  });

  it('does NOT false-positive on a namespace whose value merely contains "secret" as a substring', () => {
    expect(investigator._isReadOnlyCommand('get pods -n secret-storage').ok).toBe(true);
  });

  it('does NOT false-positive on a label value containing "secret"', () => {
    expect(investigator._isReadOnlyCommand('get pods -l app=secretary').ok).toBe(true);
  });

  it('allows an ordinary read that never mentions secrets', () => {
    expect(investigator._isReadOnlyCommand('get pods -n kube-system -o json').ok).toBe(true);
  });
});

describe('summarizeFindings — retry reuses the previous attempt', () => {
  const rca = {
    rootCause: 'container exceeds its 256Mi memory limit',
    layer: 'pod',
    confidence: 0.95,
    evidenceSufficiency: 0.9,
    evidence: ['lastState.terminated.reason=OOMKilled, exitCode=137', 'restartCount=14'],
    perLayerFindings: [
      { layer: 'pod', status: 'critical', summary: 'OOMKilled', commandsRun: [] },
      { layer: 'node', status: 'healthy', summary: 'no pressure', commandsRun: [] },
    ],
    commandsExecuted: [
      { command: 'get pod api -n shop -o yaml', result: 'x'.repeat(500) },
      { command: 'get pod api -n shop -o yaml', result: 'dup' },
      { command: 'logs api -n shop --previous', result: 'y' },
    ],
  };

  it('keeps root cause, evidence, unique commands and per-layer status', () => {
    expect(investigator.summarizeFindings(rca)).toEqual({
      rootCause: rca.rootCause,
      layer: 'pod',
      evidence: rca.evidence,
      commandsAlreadyRun: ['get pod api -n shop -o yaml', 'logs api -n shop --previous'],
      layersChecked: { pod: 'critical', node: 'healthy' },
    });
  });

  it('leaves out the previous confidence scores and raw command output', () => {
    const s = JSON.stringify(investigator.summarizeFindings(rca));
    expect(s).not.toContain('confidence');
    expect(s).not.toContain('evidenceSufficiency');
    expect(s).not.toContain('xxxxx');
  });

  it('returns null when there is nothing real to reuse', () => {
    expect(investigator.summarizeFindings(null)).toBeNull();
    expect(investigator.summarizeFindings({ rootCause: 'unknown', evidence: [], commandsExecuted: [] })).toBeNull();
  });
});
