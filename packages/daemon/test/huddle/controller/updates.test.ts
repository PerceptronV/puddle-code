import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  HUDDLE_RUNTIME_CAPABILITIES,
  daemonRuntimeCapabilities,
  hostReleaseCapabilities,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readRuntimeController } from '../../../src/runtime/ownership/storage.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { HostUpdateCompatibility } from '../../../src/updates/preflight/compatibility.js';
import {
  HostUpdateCheckpointWriter,
  readHostUpdateCheckpoint,
} from '../../../src/updates/checkpoints/store.js';
import { requireCheckpointCompatibility } from '../../../src/updates/checkpoints/compatibility.js';
import {
  HostUpdateAdoptionWriter,
  readHostUpdateAdoption,
} from '../../../src/updates/checkpoints/adoption.js';
import { inspectRecoveryDatabase } from '../../../src/updates/recovery/restart/database.js';
import { acceptedCheckpointUpdate } from '../../helpers/update-checkpoint.js';
import { huddleControllerFixture, until } from '../../helpers/huddle/controller.js';

async function fixture() {
  const f = await huddleControllerFixture(true);
  const accepted = acceptedCheckpointUpdate(f.home, 'daemon', PROTOCOL_VERSION);
  const stage = accepted.operation.stages[0]!;
  const root = join(f.home, 'bin', 'versions', stage.record.generation);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'daemon'));
  // Metadata only; no candidate executable or service is started by these tests.
  const nodePath = join(root, 'bin', 'node');
  const entryPath = join(root, 'daemon', 'puddled.mjs');
  writeFileSync(nodePath, 'fixture');
  writeFileSync(entryPath, 'fixture');
  atomicPrivateJson(join(root, '.puddle-stage.json'), stage.record);
  const candidate = hostReleaseCapabilities('0.4.0', DATABASE_SCHEMA_VERSION);
  const roles = daemonRuntimeCapabilities('0.4.0');
  writeFileSync(join(root, 'HOST_CAPABILITIES.json'), JSON.stringify(candidate));
  writeFileSync(join(root, 'DAEMON_RUNTIME_CAPABILITIES.json'), JSON.stringify(roles));
  const checkpoint = () => {
    new HostUpdateCheckpointWriter({ ...f, version: 'old' }, accepted.reference).commit(
      readRuntimeController(f.home),
    );
    return readHostUpdateCheckpoint(f.home, accepted.operation.id);
  };
  return { ...f, base: f, accepted, candidate, roles, root, nodePath, entryPath, checkpoint };
}

it('retains huddle identity/contracts in mixed checkpoints and gates both recorded and newer owners', async () => {
  const f = await fixture();
  try {
    const checkpoint = f.checkpoint();
    expect(checkpoint.owners).toHaveLength(2);
    const owner = checkpoint.owners.find((o) => o.identity.runtime_id === f.binding.runtime_id)!;
    expect(owner.huddle).toEqual({
      id: f.session.huddle_id,
      capabilities: HUDDLE_RUNTIME_CAPABILITIES,
    });
    expect(
      checkpoint.owners.find((o) => o.identity.runtime_id === f.ordinaryRuntimeId)!.huddle,
    ).toBeUndefined();
    expect(() => requireCheckpointCompatibility(f.candidate, checkpoint)).toThrow(
      'checkpointed huddle',
    );
    expect(() => requireCheckpointCompatibility(f.candidate, checkpoint, f.roles)).not.toThrow();
    const incompatible = {
      ...f.roles,
      roles: { huddle: { ...HUDDLE_RUNTIME_CAPABILITIES, ledger: 2 } },
    };
    expect(() => requireCheckpointCompatibility(f.candidate, checkpoint, incompatible)).toThrow(
      'checkpointed huddle',
    );
    const before = readFileSync(f.paths.dbFile);
    const recovery = await inspectRecoveryDatabase(f.home, f.candidate, checkpoint, f.roles);
    expect(recovery.owners.find((o) => o.huddle)?.huddle).toEqual(owner.huddle);
    expect(readFileSync(f.paths.dbFile)).toEqual(before);
    await expect(
      inspectRecoveryDatabase(f.home, f.candidate, { ...checkpoint, owners: [] }, incompatible),
    ).rejects.toThrow('checkpointed huddle');
    await expect(
      inspectRecoveryDatabase(
        f.home,
        f.candidate,
        {
          ...checkpoint,
          owners: checkpoint.owners.map((o) =>
            o.huddle ? { ...o, huddle: { ...o.huddle, id: 'a'.repeat(32) } } : o,
          ),
        },
        f.roles,
      ),
    ).rejects.toThrow('lost checkpointed runtime');
    const file = join(f.directory, 'huddle-owner.json');
    const retained = JSON.parse(readFileSync(file, 'utf8'));
    atomicPrivateJson(file, { ...retained, observation: 0, persistencePending: true });
    await expect(inspectRecoveryDatabase(f.home, f.candidate, checkpoint, f.roles)).rejects.toThrow(
      'persisted',
    );
    atomicPrivateJson(file, retained);
  } finally {
    await f.base.close();
  }
});

it('preflights both roles with explicit daemon support and never treats missing support as ordinary runtime compatibility', async () => {
  const f = await fixture();
  try {
    const inspector = new HostUpdateCompatibility({
      home: f.home,
      current: f.candidate,
      databaseSchemaVersion: () => DATABASE_SCHEMA_VERSION,
      runtimes: f.runtimes,
      connections: f.base.connections,
    });
    const inspect = () =>
      inspector.inspect(f.accepted.operation, PROTOCOL_VERSION, f.candidate.runtime, null);
    const result = await inspect();
    expect(result.blockers).toEqual([]);
    expect(result.owners).toHaveLength(2);
    expect(result.daemon_roles).toEqual(f.roles);
    writeFileSync(
      join(f.root, 'DAEMON_RUNTIME_CAPABILITIES.json'),
      JSON.stringify({ ...f.roles, roles: {} }),
    );
    expect((await inspect()).blockers).toContainEqual({
      code: 'runtime_incompatible',
      target: f.binding.runtime_id,
    });
    writeFileSync(join(f.root, 'DAEMON_RUNTIME_CAPABILITIES.json'), JSON.stringify(f.roles));
    f.db
      .prepare('UPDATE runtime_bindings SET huddle_capabilities = ? WHERE runtime_id = ?')
      .run(JSON.stringify({ ...HUDDLE_RUNTIME_CAPABILITIES, owner: 2 }), f.binding.runtime_id);
    expect(inspector.inventoryMatches(result)).toBe(false);
    expect((await inspect()).blockers).toContainEqual({
      code: 'runtime_incompatible',
      target: f.binding.runtime_id,
    });
    f.db
      .prepare('UPDATE runtime_bindings SET huddle_capabilities = ? WHERE runtime_id = ?')
      .run(JSON.stringify(HUDDLE_RUNTIME_CAPABILITIES), f.binding.runtime_id);
  } finally {
    await f.base.close();
  }
});

it('proves fresh mixed-owner adoption after replacement without replaying controllerless huddle completion', async () => {
  const f = await fixture();
  let worker: ReturnType<typeof f.accepted.store.claimExecution> | undefined;
  try {
    await f.base.run();
    await until(() => f.base.reconciler.settled(f.binding.runtime_id));
    const checkpoint = f.checkpoint();
    await f.base.disconnect();
    writeFileSync(join(f.home, 'release'), 'go');
    await until(() => existsSync(join(f.home, 'completed')));
    await f.base.replace();
    worker = f.accepted.store.claimExecution(
      f.accepted.operation,
      f.accepted.operation.dispatch_id!,
      f.accepted.operation.approved!,
    );
    const operation = worker.verifying();
    const writer = new HostUpdateAdoptionWriter({
      home: f.home,
      db: f.db,
      runtimes: f.runtimes,
      connections: f.base.connections,
      reconciler: f.base.reconciler,
      version: '0.4.0',
      nodePath: f.nodePath,
      entryPath: f.entryPath,
      port: () => 12345,
    });
    await until(() => writer.observe(operation, randomUUID()));
    const receipt = readHostUpdateAdoption(f.home, operation.id);
    expect(receipt.daemon.controller.epoch).toBeGreaterThan(checkpoint.daemon.controller.epoch);
    expect(receipt.owners).toHaveLength(2);
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    const state = f.base.client.state!;
    f.base.client.state = { ...state, persistencePending: true };
    expect(writer.observe(operation, randomUUID())).toBe(false);
    f.base.client.state = { ...state, scope: { ...state.scope, huddleId: 'b'.repeat(32) } };
    expect(writer.observe(operation, randomUUID())).toBe(false);
    f.base.client.state = state;
    expect(writer.observe(operation, randomUUID())).toBe(true);
  } finally {
    worker?.release();
    await f.base.close();
  }
});
