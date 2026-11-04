import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, type RuntimeLaunch } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { HostRuntimeRemoval } from '../../../src/host/removal/runtimes.js';
import { withRemovalRuntimes } from '../../../src/host/removal/controller.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeRequestRejected } from '../../../src/runtime/transport/client.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  launchOwner,
  waitForOwner,
  waitForSnapshot,
  terminal,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('retains the same shell processes or explicitly stops the reviewed owners through normal reconciliation', async () => {
  const f = runtimeDatabase();
  const session = f.sessions.create({ ...f.session, id: randomUUID() });
  const launch: RuntimeLaunch = {
    ...f.launch,
    identity: {
      ...f.launch.identity,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: session.id,
    },
  };
  const directory = runtimeDirectory(f.home, launch.identity.runtime_id);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  f.runtimes.prepare({
    identity: launch.identity,
    build: 'runtime-test',
    protocol: RUNTIME_PROTOCOL_VERSION,
    releasePath: directory,
  });
  const owners = [
    { launch: f.launch, directory: f.directory },
    { launch, directory },
  ].map((entry) => ({ ...entry, owner: launchOwner(f.home, entry.launch.identity.runtime_id) }));
  for (const entry of owners) await waitForOwner(entry.owner, entry.directory);
  f.controller.release();
  const connections = new RuntimeConnections(f.home, f.runtimes, {
    connected: (id, client) => f.reconciler.attach(id, client),
    missing: (id) => f.reconciler.retire(id),
  });
  const controls = new RuntimeControls(f.runtimes, connections, f.reconciler);
  const removal = new HostRuntimeRemoval({ runtimes: f.runtimes, controls });
  try {
    await connections.connect();
    const client = connections.get(f.binding.runtime_id)!;
    const original = terminal(client.state);
    await client.request({
      t: 'input',
      placement: placement(client),
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: "stty -echo; retained=unchanged; printf 'removal-ready\\n'\n",
    });
    await waitForSnapshot(client, original.generation, 'removal-ready');
    const first = await removal.review(() => true);
    expect(first.owners).toHaveLength(2);
    expect(
      first.owners.map((owner) => owner.stop),
      owners.map((entry) => entry.owner.errors()).join('\n') || undefined,
    ).toEqual(first.owners.map(() => expect.objectContaining({ fingerprint: expect.any(String) })));
    await removal.apply(first, 'retain', () => true);
    expect(terminal(client.state).pid).toBe(original.pid);
    await client.request({
      t: 'input',
      placement: placement(client),
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'printf \'retained-%s\\n\' "$retained"\n',
    });
    await waitForSnapshot(client, original.generation, 'retained-unchanged');
    for (const entry of owners) {
      expect(entry.owner.child.exitCode).toBeNull();
      expect(f.runtimes.stopRequested(entry.launch.identity.runtime_id)).toBe(false);
      expect(existsSync(join(entry.directory, 'launch.json'))).toBe(true);
    }
    await controls.spawnShell(
      f.session.id,
      f.launch.main,
      () => true,
      () => true,
    );
    await expect(removal.apply(first, 'stop', () => true)).rejects.toThrow(/changed/);
    expect(f.runtimes.stopRequested(f.binding.runtime_id)).toBe(false);
    const fresh = await removal.review(() => true);
    expect(fresh.owners.find((owner) => owner.id === f.binding.runtime_id)?.terminals).toEqual([
      'agent',
      'shell-1',
    ]);
    await controls.close();
    await f.reconciler.close();
    await connections.close();
    await expect(
      withRemovalRuntimes(f.home, async () => {
        throw new Error('Removal cancelled before disposition');
      }),
    ).rejects.toThrow('Removal cancelled');
    for (const entry of owners) {
      expect(entry.owner.child.exitCode).toBeNull();
      expect(f.runtimes.stopRequested(entry.launch.identity.runtime_id)).toBe(false);
    }
    // The real offline maintenance controller acquires ownership before opening SQLite.
    await withRemovalRuntimes(f.home, async (offline) => {
      for (const scope of ['daemon-controller', 'host-update-coordinator', 'host-update-execution'])
        expect(() => acquireHostClaim(f.home, scope)).toThrow();
      expect(() => acquireInstallationLock(f.home)).toThrow();
      await offline.apply(fresh, 'stop', () => true);
      await expect(offline.apply(fresh, 'stop', () => true)).rejects.toThrow(/changed/);
    });
    expect(f.runtimes.live()).toEqual([]);
    for (const entry of owners) {
      expect(f.runtimes.get(entry.launch.identity.runtime_id)?.state).toBe('exited');
      expect(f.runtimes.stopRequested(entry.launch.identity.runtime_id)).toBe(true);
      expect(existsSync(join(entry.directory, 'launch.json'))).toBe(true);
      expect(existsSync(join(entry.directory, 'events.json'))).toBe(true);
    }
    // Reusing the review cannot launch or stop anything again.
    await withRemovalRuntimes(f.home, async (offline) => {
      expect((await offline.review(() => true)).owners).toEqual([]);
    });
  } catch (error) {
    throw new Error(
      `Runtime removal continuity failed${error instanceof RuntimeRequestRejected ? ' during ' + error.request : ''}\n${owners.map((entry) => entry.owner.errors()).join('\n')}`,
      { cause: error },
    );
  } finally {
    await controls.close();
    await f.reconciler.close();
    await connections.close();
    f.db.close();
  }
});
