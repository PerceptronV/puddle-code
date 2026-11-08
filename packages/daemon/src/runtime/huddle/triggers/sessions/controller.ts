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
  refresh(baseline?: HuddleSessionFeedCursor) {
    this.stop();
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId),
      snapshot = this.revisions.read(activation.revision);
    requireHuddleFeatures(snapshot, this.capabilities);
    const definitions = sessionDefinitions(snapshot, activation);
    if (!definitions.length) return;
    requireSessionBaseline(snapshot, baseline);
    this.guard();
    const release = this.allowance?.reserve(1024 * 1024);
    if (this.allowance && !release)
      throw new Error('No host memory capacity for session subscriptions');
    this.release = release ?? (() => {});
    try {
      this.ledger.sessions.initialise(definitions, activation, baseline!);
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
