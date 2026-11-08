import { requireHuddleDescendantsEnded } from './containment.js';
import { closeSync, constants, fsyncSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  canonicalHuddleJson,
  huddleControlStateSchema,
  huddleRevisionActivationSchema,
  huddleRecoverySchema,
  huddleOperationRecordSchema,
  HUDDLE_REVISION_LIMITS,
  type HuddleOwnerLaunch,
  type HuddleContainment,
  type RuntimeIdentity,
  type HuddleRuntimeCapabilities,
} from '@puddle/shared';
import { requireHuddleHostFeatures } from '../triggers/definitions.js';
import { createHash } from 'node:crypto';
import { HUDDLE_STATE_LIMITS } from '../state/database.js';
import { syncPrivateDirectory } from '@puddle/shared/node';
import { runtimeDirectory } from '../../ownership/storage.js';
import {
  withHuddleReadSnapshot,
  HUDDLE_READER_LIMITS,
  retainedHuddleDirectory,
} from '../state/readers/database.js';
import { HuddleRevisionStore, readRetainedHuddleRevision } from '../state/revisions.js';

/** Caller holds source retirement/state claims and has positively fenced old descendants. */
export function copyHuddleRecoverySeed(
  home: string,
  source: HuddleOwnerLaunch,
  identity: RuntimeIdentity,
  boot: string,
  capabilities: HuddleRuntimeCapabilities,
  containment?: HuddleContainment,
) {
  if (
    !source.boot_id ||
    (source.boot_id === boot && (!containment || capabilities.crashRecovery !== 1)) ||
    identity.runtime_id === source.identity.runtime_id
  )
    throw new Error('Recovery needs a new runtime and verified descendant fencing');
  if (containment) {
    if (source.boot_id !== boot) throw new Error('Unexpected same-boot containment proof');
    requireHuddleDescendantsEnded(home, source, containment);
  }
  if (
    identity.profile_id !== source.identity.profile_id ||
    identity.project_id !== source.identity.project_id ||
    identity.session_id !== source.identity.session_id ||
    identity.canonical_worktree_path !== source.identity.canonical_worktree_path
  )
    throw new Error('Recovery placement changed');
  const directory = runtimeDirectory(home, identity.runtime_id);
  const scope = { ...source.scope, runtimeId: identity.runtime_id };
  const ancestry = source.recovery ? [source.recovery.source, ...source.recovery.ancestors] : [];
  const origins = [source.identity, ...ancestry];
  if (origins.length > 32) throw new Error('Huddle recovery lineage limit reached');
  const copied = withHuddleReadSnapshot(home, source.scope, (db) => {
    const size =
      Number(db.pragma('page_count', { simple: true })) *
      Number(db.pragma('page_size', { simple: true }));
    if (!Number.isSafeInteger(size) || size > HUDDLE_READER_LIMITS.databaseBytes)
      throw new Error('Recovery ledger exceeds its physical limit');
    return db.serialize();
  });
  const db = new Database(copied);
  let bytes: Buffer;
  let activation;
  try {
    db.pragma('trusted_schema = OFF');
    db.transaction(() => {
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'identity'").run(
        canonicalHuddleJson(scope),
      );
      // Legacy requests inherit the verified original launch, never the replacement identity.
      let after = 0;
      for (;;) {
        const row = db
          .prepare(
            "SELECT ordinal, body FROM records WHERE collection = 'operations' AND ordinal > ? ORDER BY ordinal LIMIT 1",
          )
          .get(after) as { ordinal: number; body: string } | undefined;
        if (!row) break;
        after = row.ordinal;
        if (Buffer.byteLength(row.body) > 1024 * 1024)
          throw new Error('Oversized operation record');
        const operation = huddleOperationRecordSchema.parse(JSON.parse(row.body));
        if (!['ask', 'spawn', 'resume', 'restart'].includes(operation.kind)) continue;
        const previous = db
          .prepare("SELECT body FROM records WHERE collection = 'operation-origins' AND id = ?")
          .get(operation.id);
        if (previous) continue;
        if (source.recovery)
          throw new Error('Recovered operation lost its original caller provenance');
        const body = JSON.stringify({
          format: 1,
          invocationId: operation.invocationId,
          owner: source.identity,
        });
        db.prepare(
          "INSERT INTO records(collection, id, parent, state, body, bytes) VALUES ('operation-origins', ?, ?, 'retained', ?, ?)",
        ).run(
          operation.id,
          operation.executionId,
          body,
          Buffer.byteLength(body) + operation.id.length + operation.executionId.length + 256,
        );
      }
    })();
    const read = (collection: string, id: string) => {
      const row = db
        .prepare('SELECT body FROM records WHERE collection = ? AND id = ?')
        .get(collection, id) as { body: string } | undefined;
      if (!row || Buffer.byteLength(row.body) > 1024 * 1024)
        throw new Error('Recovery activation is unavailable');
      return JSON.parse(row.body);
    };
    const control = huddleControlStateSchema.parse(read('control', 'current'));
    if (!control.activationId) throw new Error('Recovery has no recorded activation');
    activation = huddleRevisionActivationSchema.parse(
      read('revision-activations', control.activationId),
    );
    if (activation.worktree !== identity.canonical_worktree_path)
      throw new Error('Recovery worktree changed');
    const usage = db
      .prepare(
        'SELECT count(*) + coalesce(sum(reserved_records), 0) AS records, coalesce(sum(bytes + reserved), 0) AS bytes FROM records',
      )
      .get() as { records: number; bytes: number };
    if (usage.records > HUDDLE_STATE_LIMITS.records || usage.bytes > HUDDLE_STATE_LIMITS.bytes)
      throw new Error('Recovery provenance exceeds the retained ledger limit');
    bytes = db.serialize();
    if (bytes.length > HUDDLE_READER_LIMITS.databaseBytes)
      throw new Error('Recovery seed exceeds its limit');
  } finally {
    db.close();
  }
  const revisions = new HuddleRevisionStore(home, identity.runtime_id, scope.huddleId);
  const entries = readdirSync(
    join(retainedHuddleDirectory(home, source.identity.runtime_id), 'huddle-revisions'),
  );
  if (entries.length > HUDDLE_REVISION_LIMITS.records)
    throw new Error('Too many retained revisions');
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) throw new Error('Unexpected retained revision entry');
    const retained = readRetainedHuddleRevision(
      home,
      source.identity.runtime_id,
      scope.huddleId,
      entry.slice(0, -5),
    );
    requireHuddleHostFeatures(retained, capabilities);
    revisions.publish(retained);
  }
  const snapshot = revisions.read(activation.revision);
  const fd = openSync(
    join(directory, 'huddle.sqlite'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncPrivateDirectory(directory);
  const recovery = huddleRecoverySchema.parse({
    format: 1,
    source: source.identity,
    ancestors: ancestry,
    sourceBoot: source.boot_id,
    boot,
    seed: createHash('sha256').update(bytes).digest('hex'),
    ...(containment ? { containment } : {}),
  });
  return { recovery, snapshot, activation, scope };
}
