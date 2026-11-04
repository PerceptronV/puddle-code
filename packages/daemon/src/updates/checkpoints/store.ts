import { join } from 'node:path';
import {
  HOST_UPDATE_CHECKPOINT_BYTES,
  HOST_UPDATE_CHECKPOINT_OWNERS,
  hostUpdateCheckpointReferenceSchema,
  hostUpdateCheckpointSchema,
  type HostUpdateCheckpoint,
  type HostUpdateCheckpointReference,
  type RuntimeControllerRecord,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  privateDirectory,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { Db } from '../../db/db.js';
import type { RuntimeBinding, RuntimeStore } from '../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../runtime/transport/connections.js';
import { HostUpdateOperations } from '../operations/store.js';

/** Immutable ownership plus committed progress, shared by shutdown and read-only recovery. */
export function runtimeCheckpointOwner(
  owner: RuntimeBinding,
): HostUpdateCheckpoint['owners'][number] {
  return {
    identity: runtimeBindingIdentity(owner),
    build: owner.build,
    protocol: { major: owner.protocol_major, minor: owner.protocol_minor },
    release_path: owner.release_path,
    launch_fingerprint: owner.launch_fingerprint,
    event_cursor: owner.event_cursor,
    state: owner.state,
  };
}

/** A durable update receipt must never get ahead of the SQLite cursors it promises. */
export function flushUpdateDatabase(db: Db): void {
  const [flushed] = db.pragma('wal_checkpoint(FULL)') as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  if (!flushed || flushed.busy !== 0 || flushed.log !== flushed.checkpointed)
    throw new Error('Application storage did not checkpoint completely');
}

export function readHostUpdateCheckpoint(home: string, operationId: string): HostUpdateCheckpoint {
  return readHostUpdateCheckpointEvidence(home, operationId).checkpoint;
}

/** Hash all stored metadata, including additive fields an older compatible reader ignores. */
export function readHostUpdateCheckpointEvidence(home: string, operationId: string) {
  hostUpdateCheckpointReferenceSchema.shape.operation_id.parse(operationId);
  const value = readPrivateJson(
    join(home, 'updates', 'checkpoints', `${operationId}.json`),
    HOST_UPDATE_CHECKPOINT_BYTES,
  );
  const record = hostUpdateCheckpointSchema.parse(value);
  if (record.operation_id !== operationId)
    throw new Error('Host update checkpoint identity mismatch');
  return { checkpoint: record, digest: digest(`${JSON.stringify(value)}\n`) };
}

/** Capture only after all application writers drain, while the controller claim is still held. */
export class HostUpdateCheckpointWriter {
  private readonly reference: HostUpdateCheckpointReference;
  private readonly initial: string[];

  constructor(
    private readonly deps: { home: string; db: Db; runtimes: RuntimeStore; version: string },
    reference: HostUpdateCheckpointReference,
  ) {
    this.reference = hostUpdateCheckpointReferenceSchema.parse(reference);
    this.requireAccepted();
    this.initial = this.live().map((owner) => owner.runtime_id);
  }

  commit(controller: RuntimeControllerRecord): void {
    this.requireAccepted();
    if (!controller.active) throw new Error('Checkpoint requires active controller ownership');
    const owners = new Map(this.live().map((owner) => [owner.runtime_id, owner]));
    // Retain owners which ended during the drain: replacement verification must
    // observe their exact final state instead of silently dropping them.
    for (const id of this.initial) {
      const owner = this.deps.runtimes.get(id);
      if (!owner) throw new Error('Runtime disappeared during update checkpoint');
      owners.set(id, owner);
    }
    if (owners.size > HOST_UPDATE_CHECKPOINT_OWNERS)
      throw new Error('Runtime checkpoint exceeds its owner limit');
    const record = hostUpdateCheckpointSchema.parse({
      ...this.reference,
      format: 1,
      captured_at: Date.now(),
      daemon: {
        pid: process.pid,
        version: this.deps.version,
        controller: { id: controller.id, epoch: controller.epoch },
        schema_version: this.deps.db.pragma('user_version', { simple: true }),
      },
      owners: [...owners.values()]
        .sort((a, b) => a.runtime_id.localeCompare(b.runtime_id))
        .map(runtimeCheckpointOwner),
    });
    if (Buffer.byteLength(`${JSON.stringify(record)}\n`) > HOST_UPDATE_CHECKPOINT_BYTES)
      throw new Error('Runtime checkpoint exceeds its byte limit');
    try {
      readHostUpdateCheckpoint(this.deps.home, record.operation_id);
      throw new Error('Host update already has a shutdown checkpoint');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The receipt must not promise cursors whose SQLite WAL has not reached disk.
    flushUpdateDatabase(this.deps.db);
    const directory = join(this.deps.home, 'updates', 'checkpoints');
    privateDirectory(directory);
    syncPrivateDirectory(join(this.deps.home, 'updates'));
    atomicPrivateJson(join(directory, `${record.operation_id}.json`), record, {
      syncDirectory: true,
    });
  }

  private live(): RuntimeBinding[] {
    const owners = this.deps.runtimes.live(HOST_UPDATE_CHECKPOINT_OWNERS + 1);
    if (owners.length > HOST_UPDATE_CHECKPOINT_OWNERS)
      throw new Error('Runtime checkpoint exceeds its owner limit');
    return owners;
  }

  private requireAccepted(): void {
    const operation = new HostUpdateOperations(this.deps.home).read(this.reference.operation_id);
    if (
      !operation ||
      !['dispatching', 'applying'].includes(operation.phase) ||
      !operation.targets.some((target) => target.component === 'daemon') ||
      operation.dispatch_id !== this.reference.dispatch_id ||
      operation.approved !== this.reference.preflight
    )
      throw new Error('Shutdown checkpoint does not match an accepted daemon update');
  }
}
