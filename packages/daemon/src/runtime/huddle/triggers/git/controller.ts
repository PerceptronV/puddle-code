import type { HuddleRuntimeCapabilities } from '@puddle/shared';
import type { RuntimeByteAllowance } from '../../../resources/budget.js';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionStore } from '../../state/revisions.js';
import { requireHuddleFeatures } from '../definitions.js';
import { gitDefinitions } from './definitions.js';
import { GitSubscription } from './subscription.js';

/** One owner-owned set, independent of controller/renderer connections. */
export class HuddleGitController {
  private subscriptions: GitSubscription[] = [];
  private failure: unknown = null;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionStore,
    private readonly capabilities: HuddleRuntimeCapabilities,
    private readonly admitted: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly guard: () => void,
    private readonly allowance?: RuntimeByteAllowance,
  ) {}
  async refresh() {
    this.stop();
    await this.settled();
    this.subscriptions = [];
    this.failure = null;
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId),
      snapshot = this.revisions.read(activation.revision);
    requireHuddleFeatures(snapshot, this.capabilities);
    const definitions = gitDefinitions(snapshot, activation);
    try {
      if (definitions.length) {
        const release = this.allowance?.reserve((2 + 4 * definitions.length) * 1024 * 1024);
        if (this.allowance && !release)
          throw new Error('No host memory capacity for Git subscription');
        this.subscriptions.push(
          new GitSubscription(
            this.ledger,
            definitions,
            activation,
            control.generation,
            snapshot.definition.execution,
            this.admitted,
            (error) => {
              this.failure = error;
              this.stop();
              this.failed(error);
            },
            this.guard,
            release ?? (() => {}),
          ),
        );
      }
      await bounded(
        Promise.all(this.subscriptions.map((subscription) => subscription.start())).then(
          () => undefined,
        ),
      );
    } catch (error) {
      this.stop();
      throw this.failure ?? error;
    }
  }
  stop() {
    for (const subscription of this.subscriptions) subscription.stop();
  }
  async settled() {
    await bounded(
      Promise.all(
        this.subscriptions.map((subscription) => subscription.settled().catch(() => {})),
      ).then(() => undefined),
    );
  }
}
async function bounded(task: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Git scan did not settle within 15 seconds')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
