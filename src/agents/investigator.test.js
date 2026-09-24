import { describe, it, expect, beforeAll } from 'vitest';

// investigator.js pulls in ../config (OPENAI_API_KEY/OPENAI_MODEL/NOTIFICATION_SECRET)
// transitively — same pattern as graph.test.js/orchestratorAgent.test.js: set required
// env vars before the module graph loads, via a dynamic (non-hoisted) import.
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

  // Regression test: found in review 2026-08-26 — scanning only the FIRST non-flag
  // token let a flag's VALUE (the namespace here) masquerade as the resource type
  // whenever it happened to come first, so the real "secrets" token was never
  // inspected and the command was allowed through, leaking Secret values (including
  // base64 .data) into the LLM's context.
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
