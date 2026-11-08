import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  canonicalHuddleJson,
  huddleControlStateSchema,
  huddleRevisionActivationSchema,
  type HuddleOwnerState,
} from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { runtimeDirectory } from '../../../ownership/storage.js';

/** Read an existing ledger snapshot; never acquire its writer claim or run migrations. */
export function readHuddleActivation(home: string, state: HuddleOwnerState) {
  if (state.capabilities.ledger !== 1 || !state.control.activationId)
    throw new Error('No supported active huddle revision');
  const directory = runtimeDirectory(home, state.identity.runtime_id);
  privatePath(directory, true);
  const file = join(directory, 'huddle.sqlite');
  privatePath(file);
  // A live WAL owner creates both sidecars. Do not let an observation recreate
  // missing coordination files or adopt an incomplete private ledger.
  privatePath(file + '-wal');
  privatePath(file + '-shm');
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.exec('BEGIN');
    if (db.pragma('user_version', { simple: true }) !== 1)
      throw new Error('Unsupported retained huddle ledger');
    const identity = db
      .prepare(
        "SELECT CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= 4096 THEN value ELSE NULL END AS value FROM metadata WHERE key = 'identity'",
      )
      .get() as { value: string | null } | undefined;
    if (identity?.value !== canonicalHuddleJson(state.scope))
      throw new Error('Retained huddle scope differs from its owner');
    const read = (collection: string, id: string) => {
      const row = db
        .prepare(
          "SELECT CASE WHEN typeof(body) = 'text' AND length(CAST(body AS BLOB)) <= 1048576 THEN body ELSE NULL END AS body FROM records WHERE collection = ? AND id = ?",
        )
        .get(collection, id) as { body: string | null } | undefined;
      if (!row?.body) throw new Error('Retained huddle record is missing or exceeds its limit');
      return JSON.parse(row.body) as unknown;
    };
    const control = huddleControlStateSchema.parse(read('control', 'current'));
    if (canonicalHuddleJson(control) !== canonicalHuddleJson(state.control))
      throw new Error('Huddle activation changed during inspection');
    const activation = huddleRevisionActivationSchema.parse(
      read('revision-activations', control.activationId!),
    );
    if (
      activation.id !== control.activationId ||
      activation.worktree !== state.identity.canonical_worktree_path
    )
      throw new Error('Retained activation identity differs from its owner');
    return activation;
  } finally {
    db.close();
  }
}
