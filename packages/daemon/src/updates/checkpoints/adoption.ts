import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  HOST_UPDATE_CHECKPOINT_BYTES,
  PROTOCOL_VERSION,
  canonicalHuddleJson,
  hostUpdateAdoptionSchema,
  type HostUpdateAdoption,
  type HostUpdateOperation,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  privateDirectory,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import type { Db } from '../../db/db.js';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeReconciler } from '../../runtime/controller/reconcile.js';
import {
  runtimeBindingIdentity,
  type RuntimeConnections,
} from '../../runtime/transport/connections.js';
import { flushUpdateDatabase, runtimeCheckpointOwner } from './store.js';
import { huddleBindingLaunch, requireHuddleState } from '../../runtime/huddle/ownership/binding.js';
import { readUpdateAdoptionRequirements } from './requirements.js';

export function readHostUpdateAdoption(home: string, operationId: string): HostUpdateAdoption {
  hostUpdateAdoptionSchema.shape.operation_id.parse(operationId);
  const record = hostUpdateAdoptionSchema.parse(
    readPrivateJson(
      join(home, 'updates', 'adoptions', `${operationId}.json`),
      HOST_UPDATE_CHECKPOINT_BYTES,
    ),
  );
  if (record.operation_id !== operationId)
    throw new Error('Host update adoption identity mismatch');
  return record;
}

/** Called by authorised status inspection; no background writer or execution replay. */
export class HostUpdateAdoptionWriter {
  constructor(
    private readonly deps: {
      home: string;
      db: Db;
      runtimes: Pick<RuntimeStore, 'get'>;
      connections: Pick<RuntimeConnections, 'get' | 'controllerIdentity'> &
        Partial<Pick<RuntimeConnections, 'getHuddle'>>;
      reconciler: Pick<RuntimeReconciler, 'settled'>;
      version: string;
      nodePath: string;
      entryPath: string;
      port(): number | null;
    },
  ) {}

  observe(operation: HostUpdateOperation, nonce: string): boolean {
    hostUpdateAdoptionSchema.shape.nonce.parse(nonce);
    if (
      !['applying', 'verifying', 'recovery_required'].includes(operation.phase) ||
      !operation.worker_id
    )
      return false;
    const stage = operation.stages.find((item) => item.record.component === 'daemon');
    const controller = this.deps.connections.controllerIdentity();
    const port = this.deps.port();
    if (!stage || !controller || !port || stage.record.version !== this.deps.version) return false;
    const requirements = readUpdateAdoptionRequirements(this.deps.home, operation);
    const { checkpoint, digest: checkpointDigest } = requirements;
    if (
      checkpoint.dispatch_id !== operation.dispatch_id ||
      checkpoint.preflight !== operation.approved ||
      controller.id === checkpoint.daemon.controller.id ||
      controller.epoch <= checkpoint.daemon.controller.epoch
    )
      return false;
    // Same-version repairs must prove their exact generation, not just semver.
    const versions = realpathSync(join(this.deps.home, 'bin', 'versions'));
    const release = realpathSync(join(versions, stage.record.generation));
    const node = realpathSync(this.deps.nodePath);
    const entry = realpathSync(this.deps.entryPath);
    if (
      dirname(release) !== versions ||
      release !== join(versions, stage.record.generation) ||
      node !== join(release, 'bin', 'node') ||
      entry !== join(release, 'daemon', 'puddled.mjs') ||
      stage.record.protocol.major !== PROTOCOL_VERSION.major ||
      stage.record.protocol.minor !== PROTOCOL_VERSION.minor ||
      digest(`${JSON.stringify(readPrivateJson(join(release, '.puddle-stage.json'), 4096))}\n`) !==
        stage.digest
    )
      return false;
    const schemaVersion = this.deps.db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion < requirements.schema) return false;
    const owners: HostUpdateAdoption['owners'] = [];
    for (const expected of requirements.owners) {
      const id = expected.identity.runtime_id;
      const row = this.deps.runtimes.get(id);
      if (!row || !this.deps.reconciler.settled(id)) return false;
      const identity = runtimeBindingIdentity(row);
      if (
        Object.entries(expected.identity).some(
          ([key, value]) => identity[key as keyof typeof identity] !== value,
        ) ||
        canonicalHuddleJson(runtimeCheckpointOwner(row).huddle ?? null) !==
          canonicalHuddleJson(expected.huddle ?? null) ||
        row.launch_fingerprint !== expected.launch_fingerprint ||
        row.release_path !== expected.release_path ||
        row.build !== expected.build ||
        row.protocol_major !== expected.protocol.major ||
        row.protocol_minor !== expected.protocol.minor ||
        row.event_cursor < Math.max(0, expected.event_cursor) ||
        expected.state === 'interrupted' ||
        (['exited', 'failed'].includes(expected.state) && expected.state !== row.state) ||
        (row.state !== 'running' && row.state !== 'exited' && row.state !== 'failed')
      )
        return false;
      if (row.state === 'running' && row.role === 'huddle') {
        const state = this.deps.connections.getHuddle?.(id)?.state;
        if (
          !state ||
          state.state !== 'running' ||
          state.persistencePending ||
          state.observation < row.event_cursor
        )
          return false;
        try {
          requireHuddleState(huddleBindingLaunch(this.deps.home, row), state);
        } catch {
          return false;
        }
      } else if (row.state === 'running') {
        const state = this.deps.connections.get(id)?.state;
        if (
          !state ||
          state.state !== 'running' ||
          state.persistence_pending ||
          state.journal.persistence_pending ||
          state.journal.lost_through > row.event_cursor ||
          Object.entries(identity).some(
            ([key, value]) => state.identity[key as keyof typeof identity] !== value,
          ) ||
          state.build !== row.build ||
          state.protocol.major !== row.protocol_major ||
          state.protocol.minor !== row.protocol_minor ||
          state.binding?.session_id !== row.active_session_id ||
          state.binding.segment_id !== row.active_segment_id
        )
          return false;
      } else if (this.deps.connections.get(id) || this.deps.connections.getHuddle?.(id)) {
        // A final row is not enough while an old owner connection still exists.
        return false;
      }
      owners.push({
        runtime_id: id,
        event_cursor: row.event_cursor,
        state: row.state,
      });
    }
    const record = hostUpdateAdoptionSchema.parse({
      format: 1,
      nonce,
      operation_id: operation.id,
      dispatch_id: operation.dispatch_id,
      preflight: operation.approved,
      checkpoint: checkpointDigest,
      stage: stage.digest,
      observed_at: Date.now(),
      daemon: {
        pid: process.pid,
        version: this.deps.version,
        controller,
        schema_version: schemaVersion,
        port,
        protocol: PROTOCOL_VERSION,
        release_path: release,
        node_path: node,
        entry_path: entry,
      },
      owners,
    });
    if (Buffer.byteLength(`${JSON.stringify(record)}\n`) > HOST_UPDATE_CHECKPOINT_BYTES)
      throw new Error('Host update adoption exceeds its byte limit');
    flushUpdateDatabase(this.deps.db);
    const directory = join(this.deps.home, 'updates', 'adoptions');
    privateDirectory(directory);
    syncPrivateDirectory(join(this.deps.home, 'updates'));
    atomicPrivateJson(join(directory, `${operation.id}.json`), record, { syncDirectory: true });
    return true;
  }
}
