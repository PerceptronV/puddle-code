import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  HOST_UPDATE_CHECKPOINT_BYTES,
  PROTOCOL_VERSION,
  hostUpdateAdoptionSchema,
  type HostUpdateAdoption,
  type HostUpdateOperation,
  type HostUpdateReview,
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
import type { RuntimeConnections } from '../../runtime/transport/connections.js';
import { flushUpdateDatabase } from './store.js';
import { inspectAdoptionOwners } from './adoption-owners.js';
import { adoptionBlocked, HostUpdateVerificationBlocked } from '../verification/diagnostics.js';
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
    try {
      this.write(this.capture(operation, nonce));
      return true;
    } catch (error) {
      if (error instanceof HostUpdateVerificationBlocked) return false;
      throw error;
    }
  }

  /** Without a nonce this only diagnoses; it never writes or claims completion. */
  review(operation: HostUpdateOperation, nonce?: string): HostUpdateReview | undefined {
    try {
      const record = this.capture(operation, nonce ?? randomUUID());
      if (nonce) this.write(record);
      return undefined;
    } catch (error) {
      return (
        error instanceof HostUpdateVerificationBlocked
          ? error
          : new HostUpdateVerificationBlocked([
              { code: 'adoption_evidence_unavailable', target: 'daemon' },
            ])
      ).review();
    }
  }

  private capture(operation: HostUpdateOperation, nonce: string): HostUpdateAdoption {
    hostUpdateAdoptionSchema.shape.nonce.parse(nonce);
    if (
      !['applying', 'verifying', 'recovery_required'].includes(operation.phase) ||
      !operation.worker_id
    )
      adoptionBlocked('daemon_adoption_unconfirmed');
    const stage = operation.stages.find((item) => item.record.component === 'daemon');
    const controller = this.deps.connections.controllerIdentity();
    const port = this.deps.port();
    if (!stage || !controller || !port) adoptionBlocked('daemon_adoption_unconfirmed');
    if (stage.record.version !== this.deps.version) adoptionBlocked('daemon_release_changed');
    const requirements = readUpdateAdoptionRequirements(this.deps.home, operation);
    const { checkpoint, digest: checkpointDigest } = requirements;
    if (
      checkpoint.dispatch_id !== operation.dispatch_id ||
      checkpoint.preflight !== operation.approved ||
      controller.id === checkpoint.daemon.controller.id ||
      controller.epoch <= checkpoint.daemon.controller.epoch
    )
      adoptionBlocked('daemon_adoption_unconfirmed');
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
      adoptionBlocked('daemon_release_changed');
    const schemaVersion = this.deps.db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion < requirements.schema) adoptionBlocked('daemon_adoption_unconfirmed');
    const owners = inspectAdoptionOwners(this.deps, requirements.owners);
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
    return record;
  }

  private write(record: HostUpdateAdoption): void {
    flushUpdateDatabase(this.deps.db);
    const directory = join(this.deps.home, 'updates', 'adoptions');
    privateDirectory(directory);
    syncPrivateDirectory(join(this.deps.home, 'updates'));
    atomicPrivateJson(join(directory, `${record.operation_id}.json`), record, {
      syncDirectory: true,
    });
  }
}
