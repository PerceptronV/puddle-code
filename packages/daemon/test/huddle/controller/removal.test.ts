import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { HostRuntimeRemoval } from '../../../src/host/removal/runtimes.js';
import { withRemovalRuntimes } from '../../../src/host/removal/controller.js';
import { HostRemovalGuard } from '../../../src/host/removal/guard.js';
import { retirePurgeRuntimes } from '../../../src/host/removal/purge/runtimes.js';
import { CollectionBudget } from '../../../src/host/installation/collection/budget.js';
import {
  runtimeReleaseRetired,
  retireRuntimeRelease,
} from '../../../src/host/installation/collection/retirement/runtimes.js';
import { inspectReleaseReferences } from '../../../src/host/installation/collection/review.js';
import { runtimeServiceName } from '../../../src/runtime/lifecycle/supervisor.js';
import { runtimeBindingIdentity } from '../../../src/runtime/transport/connections.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { huddleControllerFixture, until } from '../../helpers/huddle/controller.js';
import { collectionRelease } from '../../helpers/release-collection.js';

it('reviews and retains both owner kinds offline, then stops the reviewed huddle without deleting source or ledger', async () => {
  const f = await huddleControllerFixture();
  const definition = join(f.home, '.puddle', 'huddle', f.session.huddle_id!);
  mkdirSync(definition, { recursive: true });
  writeFileSync(join(definition, 'notes.txt'), 'keep project sources');
  try {
    await f.run();
    await until(() => f.reconciler.settled(f.binding.runtime_id));
    await f.disconnect();
    await withRemovalRuntimes(f.home, async (removal) => {
      const review = await removal.review(() => true);
      expect(review.owners).toHaveLength(2);
      expect(review.owners.find((o) => o.id === f.binding.runtime_id)).toMatchObject({
        terminals: [],
        stop: { fingerprint: expect.any(String) },
      });
      await removal.apply(review, 'retain', () => true);
      expect(f.owner.child.exitCode).toBeNull();
      expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
      await removal.apply(review, 'stop', () => true);
      expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
      expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(true);
      await expect(removal.apply(review, 'stop', () => true)).rejects.toThrow('review changed');
    });
    expect(f.runtimes.live()).toEqual([]);
    expect(readFileSync(join(definition, 'notes.txt'), 'utf8')).toBe('keep project sources');
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    expect(existsSync(join(f.directory, 'huddle.sqlite'))).toBe(true);
    const guard = HostRemovalGuard.acquire(f.home);
    const controller = guard.acquireController();
    const run = vi.fn(async () => {
      throw new Error('No registered service exists in this fixture');
    });
    try {
      const stateFile = join(f.directory, 'huddle-owner.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      atomicPrivateJson(stateFile, { ...state, liveWorkers: true });
      await expect(
        retirePurgeRuntimes(guard, () => guard.requireController(), run),
      ).rejects.toThrow('Huddle shutdown is unresolved');
      atomicPrivateJson(stateFile, state);
      await retirePurgeRuntimes(guard, () => guard.requireController(), run);
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(join(f.directory, 'retired.json'))).toBe(true);
    } finally {
      controller.release();
      guard.release();
    }
  } finally {
    await f.close();
  }
});

it('rechecks huddle activation inside the stop queue and retains uncertain Stop without redispatch', async () => {
  const f = await huddleControllerFixture();
  const controls = new RuntimeControls(f.runtimes, f.connections, f.reconciler);
  const onlyHuddle = {
    live: () => f.runtimes.live().filter((row) => row.role === 'huddle'),
    get: f.runtimes.get.bind(f.runtimes),
    stopRequested: f.runtimes.stopRequested.bind(f.runtimes),
  };
  const removal = new HostRuntimeRemoval({ runtimes: onlyHuddle, controls });
  try {
    const review = await removal.review(() => true);
    const stop = controls.huddles.stop.bind(controls.huddles);
    const spy = vi
      .spyOn(controls.huddles, 'stop')
      .mockImplementationOnce(async (session, authority, check) => {
        await controls.huddles.arm(session, f.client.state!.control.generation, false, authority);
        return stop(session, authority, check);
      });
    await expect(removal.apply(review, 'stop', () => true)).rejects.toThrow('impact changed');
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    spy.mockRestore();
    let authorised = true;
    await expect(
      controls.huddles.stop(
        f.session.id,
        () => authorised,
        () => {
          authorised = false;
        },
      ),
    ).rejects.toMatchObject({ code: 'upstream_expired' });
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    f.runtimes.requestHuddleStop(f.binding.runtime_id, f.session.id);
    const pending = await removal.review(() => true);
    expect(pending.owners[0]!.stop).toEqual({ reason: 'stop_pending' });
    const request = vi.spyOn(f.client, 'request');
    await expect(removal.apply(pending, 'stop', () => true)).rejects.toThrow('resolved');
    expect(request.mock.calls.some(([command]) => command.t === 'shutdown')).toBe(false);
  } finally {
    await controls.close();
    await f.close();
  }
});

it('retains huddle releases through the current boot and collects only exact clean retirement evidence', async () => {
  const f = await huddleControllerFixture();
  const controls = new RuntimeControls(f.runtimes, f.connections, f.reconciler);
  try {
    await controls.huddles.stop(f.session.id, () => true);
    const ordinary = f.runtimes.get(f.ordinaryRuntimeId)!;
    await controls.stop(ordinary.active_session_id, () => true);
    await controls.close();
    await f.disconnect();
    const old = collectionRelease(f.home, '0.3.9~abc123');
    const selected = collectionRelease(f.home, '0.5.0~abc123');
    symlinkSync(selected.path, join(f.home, 'bin', 'current'));
    for (const row of [
      f.runtimes.get(f.binding.runtime_id)!,
      f.runtimes.get(f.ordinaryRuntimeId)!,
    ]) {
      const release = row.role === 'huddle' ? old : selected;
      f.db
        .prepare('UPDATE runtime_bindings SET release_path = ? WHERE runtime_id = ?')
        .run(release.path, row.runtime_id);
      const directory = join(f.home, 'runtimes', row.runtime_id);
      const identity = runtimeBindingIdentity(row);
      atomicPrivateJson(join(directory, 'assets.json'), {
        format: 1,
        node_path: join(release.path, 'bin/node'),
        files: {},
      });
      atomicPrivateJson(join(directory, 'supervisor.json'), {
        format: 1,
        identity,
        kind: 'detached',
        name: runtimeServiceName(f.home, identity, 'detached'),
        domain: null,
        node_path: join(release.path, 'bin/node'),
        entry_path: join(release.path, 'daemon/puddler.mjs'),
        state: 'removed',
      });
    }
    const binding = f.runtimes.get(f.binding.runtime_id)!;
    const run = vi.fn(async () => {
      throw new Error('Detached fixture has no supervisor');
    });
    const retire = (boot: string) =>
      retireRuntimeRelease(
        f.home,
        f.runtimes,
        binding.runtime_id,
        boot,
        () => {},
        run,
        new CollectionBudget(),
      );
    const firstBoot = randomUUID();
    const claim = acquireHostClaim(f.home, `runtime:${binding.runtime_id}`);
    try {
      await expect(retire(firstBoot)).rejects.toThrow();
    } finally {
      claim.release();
    }
    await retire(firstBoot);
    await retire(firstBoot);
    expect(runtimeReleaseRetired(f.home, binding)).toBe(false);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).not.toContain(
      old.path,
    );
    await retire(randomUUID());
    expect(runtimeReleaseRetired(f.home, binding)).toBe(true);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).toContain(
      old.path,
    );
    expect(existsSync(join(f.directory, 'huddle.sqlite'))).toBe(true);
    const stateFile = join(f.directory, 'huddle-owner.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    atomicPrivateJson(stateFile, { ...state, liveWorkers: true });
    expect(runtimeReleaseRetired(f.home, binding)).toBe(false);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).not.toContain(
      old.path,
    );
    atomicPrivateJson(stateFile, state);
    expect(run).not.toHaveBeenCalled();
  } finally {
    await controls.close();
    await f.close();
  }
});
