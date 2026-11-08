import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { spawnMailboxFixture } from '../../../helpers/huddle/spawn-mailbox.js';
import { huddleSpawnReceipt } from '../../../../src/huddle/operations/spawns/receipt.js';

it('retains cleanup independently of successful readiness and waits for durable exact confirmation', async () => {
  const f = spawnMailboxFixture();
  try {
    const pending = f.begin();
    const operation = f.spawns.claim(pending.message.id).operation;
    const agent = {
      runtimeId: randomUUID(),
      incarnation: randomUUID(),
      sessionId: randomUUID(),
      projectId: operation.request.projectId,
      worktree: operation.request.worktree,
    };
    const result = {
      agent,
      receipt: huddleSpawnReceipt(operation.scope, operation.request, agent),
    };
    f.spawns.settle(operation.scope, result);
    await pending.waiting;
    f.ledger.invocations.complete(operation.scope.invocationId, {});
    f.ledger.executions.finish(operation.scope.executionId, 'completed');
    expect(f.spawns.describe(pending.message.id).cleanup).toEqual({ state: 'retained' });
    f.ledger.spawnCleanup.request();
    expect(f.spawns.describe(pending.message.id)).toMatchObject({
      state: 'completed',
      result,
      cleanup: { state: 'pending' },
    });
    expect(() => f.spawns.cleanupSettle(operation.scope, 'unadmitted')).toThrow('shutdown');
    expect(() =>
      f.spawns.cleanupSettle({ ...operation.scope, executionId: randomUUID() }, 'stopped'),
    ).toThrow('retained');
    f.spawns.cleanupUnavailable(operation.scope, 'Original agent exit is unknown');
    f.reopen();
    expect(f.spawns.describe(pending.message.id).cleanup).toEqual({
      state: 'pending',
      error: 'Original agent exit is unknown',
    });
    let done = false;
    const waiting = f.spawns.waitForCleanup().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.spawns.cleanupSettle(operation.scope, 'stopped');
    await waiting;
    f.spawns.cleanupSettle(operation.scope, 'stopped');
    expect(f.spawns.cleanupPending).toBe(false);
    expect(f.spawns.describe(pending.message.id)).toMatchObject({
      state: 'completed',
      result,
      cleanup: { state: 'confirmed', outcome: 'stopped' },
    });
    f.reopen();
    expect(f.spawns.cleanupPending).toBe(false);
    expect(() => f.spawns.cleanupUnavailable(operation.scope, 'Changed outcome')).toThrow(
      'not pending',
    );
  } finally {
    f.close();
  }
});

it('requests cleanup atomically with execution failure and fences unclaimed spawns locally', async () => {
  const f = spawnMailboxFixture();
  try {
    const claimed = f.begin(),
      unclaimed = f.begin();
    f.spawns.claim(claimed.message.id);
    f.ledger.interrupt(f.invocation.executionId, 'failed', 'Execution deadline reached');
    expect(f.spawns.describe(claimed.message.id)).toMatchObject({
      active: false,
      state: 'unknown',
      cleanup: { state: 'pending' },
    });
    expect(f.spawns.describe(unclaimed.message.id)).toMatchObject({
      state: 'cancelled',
      cleanup: { state: 'confirmed', outcome: 'unadmitted' },
    });
    expect(f.spawns.claim(unclaimed.message.id).dispatch).toBe(false);
    f.spawns.cleanupSettle(f.spawns.describe(claimed.message.id).scope, 'unadmitted');
    claimed.abort.abort(new Error('Test ended'));
    unclaimed.abort.abort(new Error('Test ended'));
    await Promise.allSettled([claimed.waiting, unclaimed.waiting]);
    f.reopen();
    expect(f.spawns.cleanupPending).toBe(false);
  } finally {
    f.close();
  }
});
