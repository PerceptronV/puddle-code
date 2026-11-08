import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  huddleOwnerLaunchSchema,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import { huddleLaunchFixture } from '../../helpers/huddle/launch.js';
import { until } from '../../helpers/huddle/controller.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { HuddleCrashRecovery } from '../../../src/runtime/huddle/recovery/automatic.js';

// Kernel containment is checked separately; this test exercises controller admission and durable replacement intent.
vi.mock('../../../src/runtime/huddle/recovery/containment.js', async (original) => ({
  ...(await original<typeof import('../../../src/runtime/huddle/recovery/containment.js')>()),
  hasHuddleContainment: () => true,
}));

it('recovers only reconciled armed owners, drains maintenance, rechecks placement and never retries accepted replacement intent', async () => {
  const f = await huddleLaunchFixture();
  let recovery: HuddleCrashRecovery | undefined;
  try {
    const identity = {
      ...f.launch.identity,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: f.session.id,
    };
    const launch = huddleOwnerLaunchSchema.parse({
      format: 1,
      role: 'huddle',
      contract: 1,
      capabilities: HUDDLE_RUNTIME_CAPABILITIES,
      identity,
      secret: randomBytes(32).toString('hex'),
      build: 'fixture',
      lifetime: 'service',
      boot_id: await readHostBootIdentity(),
      scope: {
        hostId: 'fixture',
        runtimeId: identity.runtime_id,
        profileId: identity.profile_id,
        projectId: identity.project_id,
        sessionId: identity.session_id,
        huddleId: f.session.huddle_id,
      },
      initial: {
        id: randomUUID(),
        revision: f.options.snapshot.digest,
        worktree: identity.canonical_worktree_path,
        variables: {},
        bindings: {},
      },
    });
    const directory = runtimeDirectory(f.home, identity.runtime_id);
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const ledger = new HuddleLedger(f.home, launch.scope);
    try {
      new HuddleRevisionController(
        ledger,
        new HuddleRevisionStore(f.home, identity.runtime_id, launch.scope.huddleId),
      ).apply(f.options.snapshot, launch.initial, 0);
      ledger.activations.setIntent(1, 'armed', false); // Reboot auto-start is deliberately off.
    } finally {
      ledger.close();
    }
    const prepare = {
      build: launch.build,
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.installed.release,
      huddle: { id: launch.scope.huddleId, capabilities: launch.capabilities },
    };
    f.runtimes.prepare({ ...prepare, identity });
    const projects = new ProjectStore(f.db);
    const recoverHuddle = vi.fn(async (_session, _target, valid: () => boolean) => {
      expect(valid()).toBe(true);
      f.runtimes.prepare({
        ...prepare,
        identity: {
          ...identity,
          runtime_id: randomUUID(),
          incarnation: randomUUID(),
          launch_id: randomUUID(),
        },
        huddle: { ...prepare.huddle, recoveryFrom: identity },
      });
      throw new Error('Accepted replacement reply lost');
    });
    const storage = { assertAdmission: vi.fn(async () => {}) };
    const failed = vi.fn();
    recovery = new HuddleCrashRecovery({
      ...f,
      projects,
      launcher: { recoverHuddle },
      storage,
      failed,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoverHuddle).not.toHaveBeenCalled(); // Prepared is not authoritative owner loss.
    f.runtimes.interrupt(identity.runtime_id, () => {});
    const hold = recovery.pause();
    await hold.drain();
    f.reconciler.emit('huddle-owner-lost', identity.runtime_id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.assertAdmission).not.toHaveBeenCalled();
    // Archive lands while storage admission is awaiting a reply.
    storage.assertAdmission.mockImplementationOnce(async () => {
      projects.setArchived(f.project.id, true);
    });
    hold.release();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await until(() => storage.assertAdmission.mock.calls.length === 1);
    expect(recoverHuddle).not.toHaveBeenCalled();
    projects.setArchived(f.project.id, false);
    f.reconciler.emit('huddle-owner-lost', identity.runtime_id);
    // A pending bounded observation timer is allowed to be nudged by pause/resume.
    const retry = recovery.pause();
    await retry.drain();
    retry.release();
    await until(() => recoverHuddle.mock.calls.length === 1);
    expect(recoverHuddle.mock.calls[0]![1]).toEqual({
      runtimeId: identity.runtime_id,
      incarnation: identity.incarnation,
    });
    expect(recoverHuddle).toHaveBeenCalledWith(
      f.session.id,
      expect.anything(),
      expect.any(Function),
      { after: 'owner-crash', automatic: true },
    );
    expect(f.runtimes.get(identity.runtime_id)?.state).toBe('exited');
    const observed = recovery.pause();
    await observed.drain();
    observed.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(recoverHuddle).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await recovery?.close();
    await f.close();
  }
});
