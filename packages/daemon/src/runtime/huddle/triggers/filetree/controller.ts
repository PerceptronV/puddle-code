import type { HuddleRuntimeCapabilities } from '@puddle/shared';
import type { RuntimeByteAllowance } from '../../../resources/budget.js';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionStore } from '../../state/revisions.js';
import { requireHuddleFeatures } from '../definitions.js';
import { filetreeDefinitions } from './definitions.js';
import { FiletreeSubscription } from './subscription.js';

/** One owner-owned set, independent of controller/renderer connections. */
export class HuddleFiletreeController {
  private subscriptions: FiletreeSubscription[] = [];
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
    const definitions = filetreeDefinitions(snapshot, activation);
    try {
      for (const definition of definitions) {
        const release = this.allowance?.reserve(4 * 1024 * 1024);
        if (this.allowance && !release)
          throw new Error('No host memory capacity for Filetree subscription');
        this.subscriptions.push(
          new FiletreeSubscription(
            this.ledger,
            definition,
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
          () => reject(new Error('Filetree scan did not settle within 10 seconds')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
