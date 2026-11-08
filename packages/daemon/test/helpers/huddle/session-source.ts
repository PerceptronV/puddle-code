import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { sessionHuddleTrigger, type HuddleSessionFeedRecord } from '@puddle/shared';
import { huddleLedgerFixture } from './ledger.js';
import { schedulerSnapshot } from './scheduler.js';
import { withTrigger } from './trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { sessionDefinitions } from '../../../src/runtime/huddle/triggers/sessions/definitions.js';

export function sessionSourceFixture() {
  const base = huddleLedgerFixture(),
    worktree = realpathSync(base.home);
  const snapshot = withTrigger(
    schedulerSnapshot(base.identity.huddleId, ''),
    sessionHuddleTrigger,
    {
      worktree,
      kinds: ['terminal'],
      events: ['created', 'status'],
      statuses: ['exited'],
    },
  );
  const store = new HuddleRevisionStore(base.home, base.identity.runtimeId, base.identity.huddleId);
  const revisions = new HuddleRevisionController(base.ledger, store);
  const { activation } = revisions.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree,
      variables: {},
      bindings: { run: { worktree } },
    },
    0,
  );
  base.ledger.activations.setIntent(1, 'armed', false);
  const definitions = sessionDefinitions(snapshot, activation);
  const baseline = { epoch: 'a'.repeat(32), sequence: 10 };
  base.ledger.sessions.initialise(definitions, activation, baseline);
  const record = (
    sequence: number,
    patch: Partial<HuddleSessionFeedRecord> = {},
  ): HuddleSessionFeedRecord => ({
    sequence,
    profileId: base.identity.profileId,
    projectId: base.identity.projectId,
    sessionId: randomUUID(),
    worktree,
    sessionKind: 'terminal',
    event: 'created',
    source: 'placement',
    previousStatus: null,
    status: 'starting',
    observedAt: new Date().toISOString(),
    ...patch,
  });
  return { base, snapshot, store, activation, definitions, baseline, record };
}
