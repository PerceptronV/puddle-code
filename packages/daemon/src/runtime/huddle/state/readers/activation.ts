import {
  canonicalHuddleJson,
  huddleControlStateSchema,
  huddleRevisionActivationSchema,
  type HuddleOwnerState,
  type HuddleLedgerIdentity,
  type HuddleControlState,
} from '@puddle/shared';
import { withHuddleReadSnapshot } from './database.js';

/** Read an existing ledger snapshot; never acquire its writer claim or run migrations. */
export function readHuddleActivation(home: string, state: HuddleOwnerState) {
  if (state.capabilities.ledger !== 1 || !state.control.activationId)
    throw new Error('No supported active huddle revision');
  return readRecordedHuddleActivation(
    home,
    state.scope,
    state.identity.canonical_worktree_path,
    state.control,
  );
}

/** Last committed activation metadata is recorded evidence, not a command target. */
export function readRecordedHuddleActivation(
  home: string,
  identity: HuddleLedgerIdentity,
  worktree: string,
  expectedControl?: HuddleControlState,
) {
  return withHuddleReadSnapshot(home, identity, (db) => {
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
    if (expectedControl && canonicalHuddleJson(control) !== canonicalHuddleJson(expectedControl))
      throw new Error('Huddle activation changed during inspection');
    if (!control.activationId) throw new Error('No recorded activation');
    const activation = huddleRevisionActivationSchema.parse(
      read('revision-activations', control.activationId!),
    );
    if (activation.id !== control.activationId || activation.worktree !== worktree)
      throw new Error('Retained activation identity differs from its owner');
    return activation;
  });
}
