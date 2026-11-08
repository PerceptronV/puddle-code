import { realpathSync } from 'node:fs';
import type {
  HuddleRuntimeCapabilities,
  HuddleSessionFeedCursor,
  HuddleSessionFeedPage,
  HuddleSessionSource,
} from '@puddle/shared';
import type { RuntimeByteAllowance } from '../../../resources/budget.js';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionStore } from '../../state/revisions.js';
import { sessionDefinitions, requireSessionBaseline } from './definitions.js';
import { requireHuddleFeatures } from '../definitions.js';

export class HuddleSessionController {
  private release: (() => void) | null = null;
  private active = false;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionStore,
    private readonly capabilities: HuddleRuntimeCapabilities,
    private readonly guard: () => void,
    private readonly allowance?: RuntimeByteAllowance,
  ) {}
  refresh(baseline?: HuddleSessionFeedCursor, restoring = false) {
    this.stop();
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId),
      snapshot = this.revisions.read(activation.revision);
    requireHuddleFeatures(snapshot, this.capabilities);
    const definitions = sessionDefinitions(snapshot, activation);
    if (!definitions.length) return;
    if (!restoring) requireSessionBaseline(snapshot, baseline);
    this.guard();
    const release = this.allowance?.reserve(1024 * 1024);
    if (this.allowance && !release)
      throw new Error('No host memory capacity for session subscriptions');
    this.release = release ?? (() => {});
    try {
      if (restoring) {
        const retained = this.ledger.sessions.list();
        if (
          retained.length !== definitions.length ||
          definitions.some((definition) => {
            const source = retained.find(
              (item) => item.slot === definition.slot && item.node === definition.node,
            );
            return (
              !source ||
              source.revision !== activation.revision ||
              source.scope.worktree !== definition.worktree ||
              source.scope.sessionId !== definition.session ||
              source.scope.profileId !== this.ledger.identity.profileId ||
              source.scope.projectId !== this.ledger.identity.projectId ||
              source.scope.excludeSessionId !== this.ledger.identity.sessionId ||
              JSON.stringify(source.statuses) !== JSON.stringify(definition.statuses) ||
              JSON.stringify(source.scope.events) !== JSON.stringify(definition.events) ||
              JSON.stringify(source.scope.kinds) !== JSON.stringify(definition.kinds)
            );
          })
        )
          throw new Error('Retained session subscriptions are incomplete or changed');
      } else this.ledger.sessions.initialise(definitions, activation, baseline!);
      this.active = true;
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  list() {
    return this.active ? this.ledger.sessions.list() : [];
  }
  requireCurrent(source: HuddleSessionSource) {
    if (!this.active) throw new Error('Session subscriptions are not active');
    this.ledger.sessions.requireCurrent(source);
  }
  accept(source: HuddleSessionSource, page: HuddleSessionFeedPage) {
    this.requireCurrent(source);
    this.guard();
    if (realpathSync(source.scope.worktree) !== source.scope.worktree)
      throw new Error('Session worktree moved');
    const snapshot = this.revisions.read(source.revision);
    return this.ledger.sessions.admit(source, page, snapshot.definition.execution);
  }
  stop() {
    this.active = false;
    this.release?.();
    this.release = null;
  }
}
