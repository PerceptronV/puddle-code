import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { filetreeHuddleTrigger, type HuddleJson } from '@puddle/shared';
import { huddleLedgerFixture } from './ledger.js';
import { schedulerSnapshot } from './scheduler.js';
import { withTrigger } from './trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { filetreeDefinitions } from '../../../src/runtime/huddle/triggers/filetree/definitions.js';

export function filetreeFixture(parameters: Record<string, HuddleJson> = {}) {
  const base = huddleLedgerFixture(),
    worktree = join(realpathSync(base.home), 'worktree');
  mkdirSync(worktree);
  const snapshot = withTrigger(
    schedulerSnapshot(base.identity.huddleId, ''),
    filetreeHuddleTrigger,
    { worktree, ...parameters },
  );
  const store = new HuddleRevisionStore(base.home, base.identity.runtimeId, base.identity.huddleId);
  const revisions = new HuddleRevisionController(base.ledger, store);
  const { activation } = revisions.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree: realpathSync(base.home),
      variables: {},
      bindings: { run: { worktree } },
    },
    0,
  );
  base.ledger.activations.setIntent(1, 'armed', false);
  const definition = filetreeDefinitions(snapshot, activation)[0]!;
  return { ...base, base, worktree, snapshot, store, revisions, activation, definition };
}
