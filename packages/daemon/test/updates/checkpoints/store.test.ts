import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HOST_UPDATE_CHECKPOINT_OWNERS, runtimeStateSchema } from '@puddle/shared';
import {
  HostUpdateCheckpointWriter,
  readHostUpdateCheckpoint,
} from '../../../src/updates/checkpoints/store.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';
import { HostClaimBusy } from '../../../src/security/claims.js';
import { startDaemon } from '../../../src/daemon.js';
import { openDatabase } from '../../../src/db/db.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { launchOwner, terminal, waitForOwner } from '../../helpers/runtime-fixture.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';

it('retains exact owners, final exits and cursors without copying private launch context', async () => {
  const f = runtimeDatabase();
  try {
    const { reference } = acceptedCheckpointUpdate(f.home);
    const writer = new HostUpdateCheckpointWriter({ ...f, version: '0.3.14' }, reference);
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    writer.commit(f.controller.record);
    const file = join(f.home, 'updates', 'checkpoints', `${reference.operation_id}.json`);
    const checkpoint = readHostUpdateCheckpoint(f.home, reference.operation_id);
    expect(checkpoint).toMatchObject({
      ...reference,
      daemon: {
        version: '0.3.14',
        controller: { id: f.controller.record.id, epoch: f.controller.record.epoch },
      },
      owners: [
        {
          identity: f.launch.identity,
          state: 'exited',
          event_cursor: -1,
          build: 'runtime-test',
          release_path: f.directory,
        },
      ],
    });
    expect(checkpoint.daemon.schema_version).toBe(f.db.pragma('user_version', { simple: true }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = readFileSync(file, 'utf8');
    expect(written).not.toContain(f.launch.secret);
    expect(written).not.toContain('INITIAL');
    expect(() => writer.commit(f.controller.record)).toThrow(/already has/);
    expect(readFileSync(file, 'utf8')).toBe(written);
    writeFileSync(file, JSON.stringify({ ...checkpoint, operation_id: randomUUID() }));
    expect(() => readHostUpdateCheckpoint(f.home, reference.operation_id)).toThrow(
      /identity mismatch/,
    );
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('rechecks accepted dispatch at commit and bounds the inventory before serialisation', async () => {
  const f = runtimeDatabase();
  try {
    const { store, operation, reference } = acceptedCheckpointUpdate(f.home);
    expect(
      () =>
        new HostUpdateCheckpointWriter(
          { ...f, version: '0.3.14' },
          { ...reference, dispatch_id: randomUUID() },
        ),
    ).toThrow(/accepted/);
    const writer = new HostUpdateCheckpointWriter({ ...f, version: '0.3.14' }, reference);
    const live = vi
      .spyOn(f.runtimes, 'live')
      .mockReturnValue(Array.from({ length: HOST_UPDATE_CHECKPOINT_OWNERS + 1 }, () => f.binding));
    expect(() => writer.commit(f.controller.record)).toThrow(/owner limit/);
    expect(live).toHaveBeenCalledWith(HOST_UPDATE_CHECKPOINT_OWNERS + 1);
    live.mockRestore();
    store.requireRecovery(operation, 'Worker dispatch unconfirmed');
    expect(() => writer.commit(f.controller.record)).toThrow(/accepted/);
    expect(() => readHostUpdateCheckpoint(f.home, reference.operation_id)).toThrow(/ENOENT/);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('retains controller ownership when the drained checkpoint callback fails', async () => {
  const f = runtimeDatabase();
  f.controller.release();
  const connections = new RuntimeConnections(f.home, f.runtimes);
  try {
    await expect(
      connections.close(() => {
        expect(() => acquireRuntimeController(f.home)).toThrow(HostClaimBusy);
        throw new Error('Checkpoint storage unavailable');
      }),
    ).rejects.toThrow(/storage unavailable/);
    expect(() => acquireRuntimeController(f.home)).toThrow(HostClaimBusy);
    expect(f.runtimes.get(f.binding.runtime_id)).not.toBeNull();
    await connections.close();
    acquireRuntimeController(f.home).release();
    await expect(connections.close(() => {})).rejects.toThrow(/already released/);
  } finally {
    await connections.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('does not publish a receipt when an application WAL checkpoint is blocked', async () => {
  const f = runtimeDatabase();
  const reader = openDatabase(f.paths.dbFile);
  try {
    const { reference } = acceptedCheckpointUpdate(f.home);
    const writer = new HostUpdateCheckpointWriter({ ...f, version: '0.3.14' }, reference);
    f.db.pragma('busy_timeout = 1');
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM runtime_bindings').all();
    f.sessions.setStatus(f.session.id, 'waiting_input');
    expect(() => writer.commit(f.controller.record)).toThrow(/did not checkpoint completely/);
    expect(() => readHostUpdateCheckpoint(f.home, reference.operation_id)).toThrow(/ENOENT/);
    reader.exec('ROLLBACK');
    writer.commit(f.controller.record);
    expect(readHostUpdateCheckpoint(f.home, reference.operation_id).owners).toHaveLength(1);
  } finally {
    reader.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('publishes shutdown evidence only after admitted work drains and preserves the live owner', async () => {
  const f = runtimeDatabase();
  const owner = launchOwner(f.home, f.binding.runtime_id);
  await waitForOwner(owner, f.directory);
  const state = runtimeStateSchema.parse(readRuntimeJson(join(f.directory, 'state.json')));
  const pid = terminal(state).pid;
  f.controller.release();
  const daemon = await startDaemon({ home: f.home, adapters: [], port: 0, version: '0.3.14' });
  const accepted = acceptedCheckpointUpdate(f.home);
  const { reference } = accepted;
  const { id, epoch } = readRuntimeController(f.home);
  checkpointWorker(f.home, accepted, {
    pid: process.pid,
    controller: { id, epoch },
  });
  const release = daemon.admission.enter();
  const drain = vi.spyOn(daemon.admission, 'drain');
  let stopping: Promise<void> | undefined;
  try {
    await expect(daemon.stop({ ...reference, dispatch_id: randomUUID() })).rejects.toThrow(
      /accepted/,
    );
    daemon.admission.assertOpen();
    stopping = daemon.stop();
    expect(daemon.stop(reference)).toBe(stopping);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(() => readHostUpdateCheckpoint(f.home, reference.operation_id)).toThrow(/ENOENT/);
    expect(() => acquireRuntimeController(f.home)).toThrow(HostClaimBusy);
    release();
    await stopping;
    const checkpoint = readHostUpdateCheckpoint(f.home, reference.operation_id);
    expect(checkpoint.owners).toHaveLength(1);
    expect(checkpoint.owners[0]).toMatchObject({ identity: f.launch.identity, state: 'running' });
    expect(checkpoint.owners[0]!.event_cursor).toBeGreaterThanOrEqual(0);
    process.kill(pid!, 0);
    const replacement = await startDaemon({ home: f.home, adapters: [], port: 0 });
    try {
      expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('running');
      process.kill(pid!, 0);
    } finally {
      await replacement.stop();
    }
    expect(readHostUpdateCheckpoint(f.home, reference.operation_id)).toEqual(checkpoint);
  } finally {
    drain.mockRestore();
    release();
    await (stopping ?? daemon.stop());
    await f.reconciler.close();
    f.db.close();
  }
});
