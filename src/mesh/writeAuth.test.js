import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { signWrite, verifyWrite, WRITE_AUTH_TTL_MS } = require('./writeAuth.js');
const { Bus } = require('./bus.js');

// k8s-write's authorization is what stops any bus client (every agent shares one Redis
// ACL user) from enqueueing a cluster mutation directly. All refusals must be RefuseErrors.

const step  = { command: 'rollout restart deployment/api -n shop', target: { kind: 'Deployment', name: 'api', namespace: 'shop' } };
const input = { step, context: 'minikube' };
const TASK  = 'wf1:apply:k:1:0';

describe('writeAuth', () => {
  let saved;
  beforeEach(() => { saved = process.env.MESH_WRITE_SIGNING_KEY; process.env.MESH_WRITE_SIGNING_KEY = 'test-key'; });
  afterEach(() => { if (saved === undefined) delete process.env.MESH_WRITE_SIGNING_KEY; else process.env.MESH_WRITE_SIGNING_KEY = saved; });

  it('accepts a step signed by the orchestrator for this task id', () => {
    const auth = signWrite(input, TASK);
    expect(() => verifyWrite({ ...input, auth }, TASK)).not.toThrow();
  });

  it('refuses an unsigned apply', () => {
    expect(() => verifyWrite(input, TASK)).toThrow(expect.objectContaining({ refuse: true }));
  });

  it('refuses a valid signature reused for another command, context or task id', () => {
    const auth = signWrite(input, TASK);
    const refused = expect.objectContaining({ refuse: true });
    expect(() => verifyWrite({ step: { ...step, command: 'delete deploy api -n shop' }, context: 'minikube', auth }, TASK)).toThrow(refused);
    expect(() => verifyWrite({ ...input, context: 'prod', auth }, TASK)).toThrow(refused);
    expect(() => verifyWrite({ ...input, auth }, 'wf1:apply:k:1:0:other')).toThrow(refused);
  });

  it('refuses an expired authorization', () => {
    const auth = signWrite(input, TASK, Date.now() - WRITE_AUTH_TTL_MS - 1);
    expect(() => verifyWrite({ ...input, auth }, TASK)).toThrow(/expired/);
  });

  it('refuses everything when the gateway has no key (fails closed)', () => {
    const auth = signWrite(input, TASK);
    delete process.env.MESH_WRITE_SIGNING_KEY;
    expect(() => verifyWrite({ ...input, auth }, TASK)).toThrow(/not configured/);
  });
});

describe('bus done-cache integrity', () => {
  const quiet = { warn: () => {}, error: () => {}, log: () => {} };

  it('round-trips its own sealed entries', () => {
    const bus = new Bus({ url: 'redis://unused', serviceName: 't', integrityKey: 'k', logger: quiet });
    const raw = bus._sealDone(TASK, 'inform', { output: 'ok' });
    expect(bus._openDone(TASK, raw, 'k8s-write.apply')).toEqual({ performative: 'inform', fields: { output: 'ok' } });
  });

  it('ignores a forged entry and a genuine entry copied under another task id', () => {
    const bus = new Bus({ url: 'redis://unused', serviceName: 't', integrityKey: 'k', logger: quiet });
    const forged = JSON.stringify({ performative: 'inform', fields: { output: 'ok' } });
    expect(bus._openDone(TASK, forged, 'k8s-write.apply')).toBeNull();
    const genuine = bus._sealDone('other-task', 'inform', { output: 'ok' });
    expect(bus._openDone(TASK, genuine, 'k8s-write.apply')).toBeNull();
  });

  it('without an integrity key behaves exactly as before', () => {
    const bus = new Bus({ url: 'redis://unused', serviceName: 't', logger: quiet });
    const raw = JSON.stringify({ performative: 'inform', fields: { output: 1 } });
    expect(bus._openDone(TASK, raw, 'x')).toEqual({ performative: 'inform', fields: { output: 1 } });
  });
});
