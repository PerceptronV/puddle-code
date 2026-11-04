import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeClient } from '../../../../src/runtime/transport/client.js';
import { ReleaseCollectionMaintenance } from '../../../../src/host/installation/collection/maintenance.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import {
  bundleDir,
  admitFixtureOwner,
  children,
  clients,
  environment,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../../helpers/runtime-fixture.js';
import { placement } from '../../../helpers/runtime-placement.js';
import { collectionRelease } from '../../../helpers/release-collection.js';

it('reclaims an unused generation while a real isolated provider runtime retains PID, PTY and shell memory', async () => {
  const f = runtimeDatabase('interactive');
  const ownerRelease = collectionRelease(f.home, '0.3.9~abc123');
  const selected = collectionRelease(f.home, '0.4.0~abc123');
  const unused = collectionRelease(f.home, '0.3.8~abc123');
  symlinkSync(selected.path, join(f.home, 'bin/current'));
  // Execute the fixture provider from a real pinned Node/helper generation.
  copyFileSync(process.execPath, join(ownerRelease.path, 'bin/node'));
  chmodSync(join(ownerRelease.path, 'bin/node'), 0o700);
  cpSync(bundleDir, join(ownerRelease.path, 'daemon'), { recursive: true });
  f.db
    .prepare("UPDATE runtime_bindings SET release_path = ?, state = 'running' WHERE runtime_id = ?")
    .run(ownerRelease.path, f.binding.runtime_id);
  admitFixtureOwner(f.home, f.binding.runtime_id);
  const child = spawn(
    join(ownerRelease.path, 'bin/node'),
    [
      join(ownerRelease.path, 'daemon/provider-owner.mjs'),
      '--home',
      f.home,
      '--runtime',
      f.binding.runtime_id,
    ],
    { env: environment(f.home), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  children.push(child);
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await waitForOwner({ child, errors: () => errors }, f.directory);
  const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(client);
  const before = terminal(client.state);
  await client.request({
    placement: placement(client),
    t: 'input',
    term: 'agent',
    generation: before.generation,
    source: 'human',
    data: 'stty -echo; collection_state=survived; printf "before-%s\\n" "$collection_state"\n',
  });
  await waitForSnapshot(client, before.generation, 'before-survived');
  const collector = new ReleaseCollectionMaintenance({
    home: f.home,
    runtimes: f.runtimes,
    controller: () => f.controller.record,
    pause: async () => ({ release() {} }),
    boot: async () => randomUUID(),
    run: async () => {
      throw new Error('Live collection must not call a supervisor');
    },
  });
  try {
    await collector.flush();
    expect(existsSync(unused.path)).toBe(false);
    expect(existsSync(ownerRelease.path)).toBe(true);
    expect(child.exitCode).toBeNull();
    await client.request({ t: 'inspect' });
    expect(terminal(client.state)).toEqual(before);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: before.generation,
      source: 'human',
      data: 'printf "after-%s\\n" "$collection_state"\n',
    });
    await waitForSnapshot(client, before.generation, 'after-survived');
  } finally {
    await collector.close();
    await f.reconciler.close();
    f.db.close();
  }
});
