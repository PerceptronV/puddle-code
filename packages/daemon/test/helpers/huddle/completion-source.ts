import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  completionHuddleTrigger,
  type HuddleCompletionBaseline,
  type RuntimeNativeTurnRecord,
} from '@puddle/shared';
import { huddleLedgerFixture } from './ledger.js';
import { schedulerSnapshot } from './scheduler.js';
import { withTrigger } from './trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { completionDefinitions } from '../../../src/runtime/huddle/triggers/completions/definitions.js';

export function completionSourceFixture(limits?: { records?: number; bytes?: number }) {
  const base = huddleLedgerFixture(limits),
    worktree = realpathSync(base.home),
    session = randomUUID();
  try {
    const snapshot = withTrigger(
      schedulerSnapshot(base.identity.huddleId, ''),
      completionHuddleTrigger,
      { worktree, session },
    );
    const store = new HuddleRevisionStore(
      base.home,
      base.identity.runtimeId,
      base.identity.huddleId,
    );
    const revisions = new HuddleRevisionController(base.ledger, store);
    const { activation } = revisions.apply(
      snapshot,
      {
        id: randomUUID(),
        worktree,
        variables: {},
        bindings: { run: { worktree, session } },
      },
      0,
    );
    base.ledger.activations.setIntent(1, 'armed', false);
    const definitions = completionDefinitions(snapshot, activation);
    const baseline: HuddleCompletionBaseline = {
      node: 'run',
      cursor: { epoch: 'a'.repeat(32), sequence: 10 },
      target: {
        identity: {
          runtime_id: randomUUID(),
          incarnation: randomUUID(),
          launch_id: randomUUID(),
          session_id: randomUUID(),
          profile_id: base.identity.profileId,
          project_id: base.identity.projectId,
          canonical_worktree_path: worktree,
        },
        sessionId: session,
        segmentId: randomUUID(),
        nativeRef: 'native-conversation',
      },
    };
    base.ledger.completions.initialise(definitions, activation, [baseline]);
    const record = (
      sequence: number,
      patch: Partial<RuntimeNativeTurnRecord> = {},
    ): RuntimeNativeTurnRecord => ({
      sequence,
      observedAt: new Date().toISOString(),
      event: 'completed',
      sessionId: session,
      segmentId: baseline.target.segmentId,
      agentSessionRef: baseline.target.nativeRef,
      nativeTurnId: `native-${sequence}`,
      reply: `reply ${sequence}`,
      origin: { kind: 'external' },
      ...patch,
    });
    return { base, worktree, session, snapshot, store, activation, definitions, baseline, record };
  } catch (error) {
    base.cleanup();
    throw error;
  }
}
