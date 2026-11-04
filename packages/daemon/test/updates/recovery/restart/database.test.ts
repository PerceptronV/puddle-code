import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';
import { RuntimeClient } from '../../../../src/runtime/transport/client.js';
import {
  readRuntimeController,
  runtimeDirectory,
} from '../../../../src/runtime/ownership/storage.js';
import {
  HostUpdateCheckpointWriter,
  readHostUpdateCheckpoint,
} from '../../../../src/updates/checkpoints/store.js';
import { inspectRecoveryDatabase } from '../../../../src/updates/recovery/restart/database.js';
import { acceptedCheckpointUpdate } from '../../../helpers/update-checkpoint.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { clients, launchOwner, terminal, waitForOwner } from '../../../helpers/runtime-fixture.js';

async function fixture() {
  const f = runtimeDatabase();
  const owner = launchOwner(f.home, f.binding.runtime_id);
  await waitForOwner(owner, f.directory);
  const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(client);
  await f.reconciler.attach(f.binding.runtime_id, client);
  const accepted = acceptedCheckpointUpdate(f.home);
  new HostUpdateCheckpointWriter({ ...f, version: '0.4.0' }, accepted.reference).commit(
    f.controller.record,
  );
  const checkpoint = readHostUpdateCheckpoint(f.home, accepted.operation.id);
  return {
    ...f,
    client,
    checkpoint,
    candidate: hostReleaseCapabilities('0.4.0', DATABASE_SCHEMA_VERSION),
    async close() {
      await f.reconciler.close();
      client.close();
      f.db.close();
    },
  };
}

it('reads current committed runtime bindings without changing application storage, controller or live shell', async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.paths.dbFile);
    const controller = readRuntimeController(f.home);
    const pid = terminal(f.client.state!).pid!;
    const result = await inspectRecoveryDatabase(f.home, f.candidate, f.checkpoint);
    expect(result.schema).toBe(DATABASE_SCHEMA_VERSION);
    expect(result.inventory).toMatch(/^[a-f0-9]{64}$/);
    expect(readRuntimeController(f.home)).toEqual(controller);
    expect(readFileSync(f.paths.dbFile)).toEqual(before);
    process.kill(pid, 0);
    expect(terminal(f.client.state!).pid).toBe(pid);
  } finally {
    await f.close();
  }
});

it('sees committed WAL migrations instead of treating the main database file as the current schema', async () => {
  const f = await fixture();
  try {
    f.db.pragma('wal_autocheckpoint = 0');
    f.db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`);
    const main = readFileSync(f.paths.dbFile);
    const wal = readFileSync(`${f.paths.dbFile}-wal`);
    await expect(inspectRecoveryDatabase(f.home, f.candidate, f.checkpoint)).rejects.toThrow(
      'Current database schema',
    );
    expect(readFileSync(f.paths.dbFile)).toEqual(main);
    expect(readFileSync(`${f.paths.dbFile}-wal`)).toEqual(wal);
  } finally {
    await f.close();
  }
});

it('includes runtime launches recorded after the original shutdown checkpoint', async () => {
  const f = await fixture();
  try {
    const session = f.sessions.create({ ...f.session, id: randomUUID() });
    const launch = {
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
      build: 'newer-runtime',
      protocol: { major: 99, minor: 0 },
      releasePath: directory,
    });
    await expect(inspectRecoveryDatabase(f.home, f.candidate, f.checkpoint)).rejects.toThrow(
      'cannot adopt a current runtime',
    );
    process.kill(terminal(f.client.state!).pid!, 0);
  } finally {
    await f.close();
  }
});

it.each(['protocol', 'cursor', 'identity', 'unknown-directory'])(
  'refuses current runtime %s changes which the old checkpoint cannot authorise',
  async (change) => {
    const f = await fixture();
    try {
      if (change === 'protocol')
        f.db
          .prepare('UPDATE runtime_bindings SET protocol_major = 99 WHERE runtime_id = ?')
          .run(f.binding.runtime_id);
      if (change === 'cursor')
        f.db
          .prepare('UPDATE runtime_bindings SET event_cursor = -1 WHERE runtime_id = ?')
          .run(f.binding.runtime_id);
      if (change === 'identity')
        f.db
          .prepare('UPDATE runtime_bindings SET incarnation = ? WHERE runtime_id = ?')
          .run(randomUUID(), f.binding.runtime_id);
      if (change === 'unknown-directory')
        mkdirSync(join(f.home, 'runtimes', randomUUID()), { mode: 0o700 });
      await expect(inspectRecoveryDatabase(f.home, f.candidate, f.checkpoint)).rejects.toThrow();
      process.kill(terminal(f.client.state!).pid!, 0);
    } finally {
      await f.close();
    }
  },
);
