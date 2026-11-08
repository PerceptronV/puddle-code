import { realpathSync } from 'node:fs';
import type {
  HuddleCompletionBaseline,
  HuddleCompletionSource,
  HuddleRuntimeCapabilities,
  HuddleRevisionActivation,
  RuntimeNativeTurnPage,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';
import type { RuntimeByteAllowance } from '../../../resources/budget.js';
import { runtimeJsonRetainedBytes } from '../../../transport/encoding.js';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionStore } from '../../state/revisions.js';
import { requireHuddleFeatures } from '../definitions.js';
import { completionDefinitions } from './definitions.js';
import { validateCompletionBaselines } from './baselines.js';

export class HuddleCompletionController {
  private release: (() => void) | null = null;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionStore,
    private readonly capabilities: HuddleRuntimeCapabilities,
    private readonly guard: () => void,
    private readonly allowance?: RuntimeByteAllowance,
  ) {}

  validate(
    snapshot: HuddleDefinitionSnapshot,
    activation: HuddleRevisionActivation,
    baselines?: HuddleCompletionBaseline[],
  ) {
    requireHuddleFeatures(snapshot, this.capabilities);
    if (baselines !== undefined && this.capabilities.completionEvents !== 1)
      throw new Error('Owner has no completion subscription capability');
    const definitions = completionDefinitions(snapshot, activation);
    if (definitions.length) this.guard();
    validateCompletionBaselines(definitions, activation, baselines, this.ledger.identity);
    return definitions;
  }

  refresh(baselines?: HuddleCompletionBaseline[]) {
    this.stop();
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId);
    const definitions = this.validate(
      this.revisions.read(activation.revision),
      activation,
      baselines,
    );
    if (!definitions.length) return;
    const release = this.allowance?.reserve(256 * 1024);
    if (this.allowance && !release)
      throw new Error('No host memory capacity for completion subscriptions');
    this.release = release ?? (() => {});
    try {
      this.ledger.completions.initialise(definitions, activation, baselines!);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  list() {
    return this.release ? this.ledger.completions.list() : [];
  }

  requireCurrent(source: HuddleCompletionSource) {
    if (!this.release) throw new Error('Completion subscriptions are not active');
    this.ledger.completions.requireCurrent(source);
  }

  accept(source: HuddleCompletionSource, page: RuntimeNativeTurnPage) {
    this.requireCurrent(source);
    this.guard();
    const worktree = source.target.identity.canonical_worktree_path;
    if (realpathSync(worktree) !== worktree) throw new Error('Completion worktree moved');
    // The transport owns the request charge. This allowance covers validation copies,
    // event/cursor admission and JSON encoding until the synchronous transaction ends.
    const release = this.allowance?.reserve(4 * runtimeJsonRetainedBytes(page) + 256 * 1024);
    if (this.allowance && !release)
      throw new Error('No host memory capacity for completion admission');
    try {
      const snapshot = this.revisions.read(source.revision);
      return this.ledger.completions.admit(source, page, snapshot.definition.execution);
    } finally {
      release?.();
    }
  }

  stop() {
    this.release?.();
    this.release = null;
  }
}
