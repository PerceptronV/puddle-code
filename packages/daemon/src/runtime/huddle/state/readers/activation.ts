import {
  canonicalHuddleJson,
  huddleControlStateSchema,
  huddleRevisionActivationSchema,
  type HuddleOwnerState,
} from '@puddle/shared';
import { withHuddleReadSnapshot } from './database.js';

/** Read an existing ledger snapshot; never acquire its writer claim or run migrations. */
export function readHuddleActivation(home: string, state: HuddleOwnerState) {
  if (state.capabilities.ledger !== 1 || !state.control.activationId)
    throw new Error('No supported active huddle revision');
  return withHuddleReadSnapshot(home, state.scope, (db) => {
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
  });
}
