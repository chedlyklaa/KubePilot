import { describe, it, expect, beforeAll } from 'vitest';

let escalate;
beforeAll(async () => {
  process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';
  ({ escalate } = await import('./escalationStore.js'));
});

// Fake EscalationHistory model
function fakeEscalationHistoryModel() {
  let n = 0;
  return {
    create: async () => ({ _id: { toString: () => `mongo-id-${++n}` } }),
    findByIdAndUpdate: async () => {},
  };
}

// Fake notification engine
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
      // Mock eligible recipients
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
