import { describe, it, expect, beforeAll } from 'vitest';

// escalationStore.js transitively requires services/notifications/crypto.js, which
// throws at import time if NOTIFICATION_SECRET is unset — set it before the module
// graph loads. A dynamic import() (not hoisted, unlike a static import) lets this run
// first instead of racing a hoisted static import.
let escalate;
beforeAll(async () => {
  process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';
  ({ escalate } = await import('./escalationStore.js'));
});

// Fake EscalationHistory model — enough shape for the "new escalation" path
// (.create()) used by every test below; dedup/re-escalation path (.findByIdAndUpdate)
// isn't exercised here so it's a no-op stub.
function fakeEscalationHistoryModel() {
  let n = 0;
  return {
    create: async () => ({ _id: { toString: () => `mongo-id-${++n}` } }),
    findByIdAndUpdate: async () => {},
  };
}

// Fake notifEngine whose emit() resolves a promise the test can await — escalate()
// fires the notification asynchronously via a detached `.then()` chain, so we need
// a hook to know when it actually happened rather than guessing with a timer.
function fakeNotifEngine() {
  let resolveEmitted;
  const emitted = new Promise(resolve => { resolveEmitted = resolve; });
  return {
    emitted,
    emit: async (payload) => { resolveEmitted(payload); return { delivered: true }; },
  };
}

describe('escalationStore.escalate — notification targeting', () => {
  it('sends the escalation only to the resolved eligible-recipient list, not a hard-coded broadcast', async () => {
    const notifEngine = fakeNotifEngine();
    const deps = {
      EscalationHistoryModel: fakeEscalationHistoryModel(),
      notifEngine,
      // Simulates permissionService.getEligibleRecipients narrowing down to exactly
      // one specific user (an admin plus one developer scoped to this namespace) —
      // NOT every registered user.
      getEligibleRecipients: async () => ['admin-1', 'dev-with-access'],
    };

    await escalate(
      'test-issue-scoped-targets',
      { clusterName: 'prod', namespace: 'team-a', type: 'CrashLoopBackOff' },
      [{ action: 'restart', outcome: 'failed' }],
      null,
      deps
    );

    const payload = await notifEngine.emitted;
    expect(payload.targetUserIds).toEqual(['admin-1', 'dev-with-access']);
    expect(payload.targetUserIds).not.toContain('dev-without-access');
    expect(payload.title).toContain('test-issue-scoped-targets');
  });

  it('notifies exactly one specific user when they are the only eligible recipient', async () => {
    const notifEngine = fakeNotifEngine();
    const deps = {
      EscalationHistoryModel: fakeEscalationHistoryModel(),
      notifEngine,
      getEligibleRecipients: async () => ['only-eligible-admin'],
    };

    await escalate(
      'test-issue-single-target',
      { clusterName: 'staging', namespace: 'team-b', type: 'OOMKilled' },
      [{ action: 'increase_memory', outcome: 'failed' }],
      null,
      deps
    );

    const payload = await notifEngine.emitted;
    expect(payload.targetUserIds).toEqual(['only-eligible-admin']);
    expect(payload.targetUserIds).toHaveLength(1);
  });

  it('falls back to admins-only if permission lookup fails, instead of notifying nobody', async () => {
    const notifEngine = fakeNotifEngine();
    const deps = {
      EscalationHistoryModel: fakeEscalationHistoryModel(),
      notifEngine,
      getEligibleRecipients: async () => { throw new Error('DB unreachable'); },
      getAdminIds: async () => ['admin-fallback-1', 'admin-fallback-2'],
    };

    await escalate(
      'test-issue-fallback-targets',
      { clusterName: 'prod', namespace: 'team-a', type: 'CrashLoopBackOff' },
      [{ action: 'restart', outcome: 'failed' }],
      null,
      deps
    );

    const payload = await notifEngine.emitted;
    expect(payload.targetUserIds).toEqual(['admin-fallback-1', 'admin-fallback-2']);
  });
});
