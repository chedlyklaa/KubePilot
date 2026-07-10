import { describe, it, expect } from 'vitest';
import { CommandCompletenessValidator, INTENT_SCHEMAS } from './commandValidator.js';

const validator = new CommandCompletenessValidator();

describe('CommandCompletenessValidator.validate', () => {
  it('flags a missing action as incomplete', () => {
    expect(validator.validate({})).toEqual({ complete: false, missingFields: ['action'] });
    expect(validator.validate(null)).toEqual({ complete: false, missingFields: ['action'] });
  });

  it('lets an unrecognized action through untouched (LLM decides)', () => {
    const r = validator.validate({ action: 'some_future_action', params: {} });
    expect(r).toEqual({ complete: true, missingFields: [] });
  });

  it('is complete when every required field is present', () => {
    const r = validator.validate({
      action: 'delete_pod',
      params: { pod: 'my-pod', namespace: 'default' },
    });
    expect(r.complete).toBe(true);
    expect(r.missingFields).toEqual([]);
  });

  it('reports each missing required field', () => {
    const r = validator.validate({ action: 'scale_deployment', params: { deployment: 'api' } });
    expect(r.complete).toBe(false);
    expect(r.missingFields.sort()).toEqual(['namespace', 'replicas'].sort());
  });

  it.each(['', 'unknown', 'Unspecified', 'NULL', '  '])(
    'treats placeholder value %j as missing, not present',
    value => {
      const r = validator.validate({
        action: 'delete_pod',
        params: { pod: value, namespace: 'default' },
      });
      expect(r.complete).toBe(false);
      expect(r.missingFields).toContain('pod');
    }
  );

  it('requires no fields at all for read-only list actions', () => {
    const r = validator.validate({ action: 'get_pods', params: {} });
    expect(r).toEqual({ complete: true, missingFields: [] });
  });
});

describe('CommandCompletenessValidator.detectAmbiguity', () => {
  it('returns null when there are no candidates', () => {
    expect(validator.detectAmbiguity({})).toBeNull();
  });
  it('returns null when there is exactly one candidate (not actually ambiguous)', () => {
    expect(validator.detectAmbiguity({ ambiguousCandidates: ['api-1'] })).toBeNull();
  });
  it('returns the candidate list when there are 2 or more', () => {
    const candidates = ['api-1', 'api-2'];
    expect(validator.detectAmbiguity({ ambiguousCandidates: candidates })).toEqual(candidates);
  });
});

describe('CommandCompletenessValidator.buildQuestion', () => {
  it('asks the user to disambiguate when candidates are present', () => {
    const q = validator.buildQuestion('delete_pod', [], ['api-1', 'api-2']);
    expect(q).toMatch(/api-1, api-2/);
  });

  it('asks for a single missing field by its human label', () => {
    const q = validator.buildQuestion('delete_pod', ['namespace'], null);
    expect(q).toBe('What namespace should I use?');
  });

  it('joins multiple missing fields with "and"', () => {
    const q = validator.buildQuestion('scale_deployment', ['replicas', 'namespace'], null);
    expect(q).toMatch(/replica count/);
    expect(q).toMatch(/and namespace/);
  });

  it('falls back to a generic prompt when nothing specific is missing', () => {
    expect(validator.buildQuestion('noop', [], null)).toBe('Can you provide more details?');
  });
});

describe('CommandCompletenessValidator.getSchema', () => {
  it('returns the schema for a known action', () => {
    expect(validator.getSchema('delete_pod')).toEqual({ required: ['pod', 'namespace'] });
  });
  it('returns null for an unknown action', () => {
    expect(validator.getSchema('not_a_real_action')).toBeNull();
  });
  it('exposes the full schema map statically for other modules', () => {
    expect(CommandCompletenessValidator.INTENT_SCHEMAS).toBe(INTENT_SCHEMAS);
  });
});
