import type {
  HuddleCustomTriggerSource,
  HuddleRuntimeCapabilities,
  HuddleComponent,
  HuddleDefinition,
  HuddleTriggerWorkerJob,
} from '@puddle/shared';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionStore } from '../../state/revisions.js';
import { prepareHuddleTriggerJob } from '../../../../huddle/definitions/worker.js';
import { customTriggerDefinitions } from './definitions.js';
import {
  startHuddleWorker,
  HuddleWorkerTerminationUnknown,
  type HuddleWorkerHandle,
  type HuddleWorkerOptions,
} from '../../workers/process.js';

type WorkerOptions = Pick<
  HuddleWorkerOptions,
  'nodePath' | 'entryPath' | 'allowance' | 'environment'
>;
interface Subscription {
  source: HuddleCustomTriggerSource;
  handle: HuddleWorkerHandle;
  closing: boolean;
  settled: Promise<void>;
}

/** Independent, bounded subscriptions; one failed adapter does not stop other sources. */
export class HuddleCustomTriggerController {
  private readonly live = new Map<number, Subscription>();
  private epoch = 0;
  private blocked: Error | null = null;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly store: HuddleRevisionStore,
    private readonly capabilities: HuddleRuntimeCapabilities,
    private readonly options: WorkerOptions,
    private readonly admitted: () => void,
    private readonly changed: () => void,
    private readonly fatal: (error: unknown) => void,
    private readonly beforeAdmission: () => void,
  ) {}
  get hasLiveWorkers() {
    return this.live.size > 0;
  }
  stop() {
    this.epoch++;
    let failure: unknown;
    for (const subscription of this.live.values()) {
      subscription.closing = true;
      try {
        this.ledger.customTriggers.close(subscription.source);
      } catch (error) {
        failure ??= error;
      } finally {
        subscription.handle.cancel('Custom trigger subscription stopped');
      }
    }
    if (failure) this.blocked = failure instanceof Error ? failure : new Error(String(failure));
  }
  async settled() {
    await Promise.all([...this.live.values()].map((item) => item.settled));
    if (this.blocked) throw this.blocked;
  }
  async refresh() {
    this.stop();
    const epoch = this.epoch;
    await this.settled();
    if (epoch !== this.epoch) return;
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId);
    const snapshot = this.store.read(activation.revision);
    const definitions = customTriggerDefinitions(snapshot, activation);
    if (!definitions.length) return;
    if (this.capabilities.customTriggers !== 1)
      throw new Error('Owner has no custom trigger capability');
    const sources = this.ledger.customTriggers.synchronise(activation, definitions);
    for (const source of sources) {
      try {
        this.beforeAdmission();
        const job = prepareHuddleTriggerJob(
          snapshot,
          activation,
          source.node,
          source.id,
          source.cursor,
        );
        this.start(
          source,
          job,
          snapshot.components[source.node]!,
          snapshot.definition.execution,
          activation.worktree,
          epoch,
        );
      } catch (error) {
        this.failed(source, error);
      }
    }
    this.notify();
  }
  private notify() {
    try {
      this.changed();
    } catch (error) {
      this.blocked = error instanceof Error ? error : new Error(String(error));
      this.fatal(this.blocked);
    }
  }
  private failed(source: HuddleCustomTriggerSource, error: unknown) {
    const current = this.ledger.customTriggers.requireCurrent(source);
    if (current.health.state !== 'gap' && current.health.state !== 'closed')
      this.ledger.customTriggers.health(source, {
        state: 'gap',
        message:
          (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
          'Custom trigger failed',
        after: current.cursor,
      });
  }
  private start(
    source: HuddleCustomTriggerSource,
    job: HuddleTriggerWorkerJob,
    component: HuddleComponent,
    limits: HuddleDefinition['execution'],
    cwd: string,
    epoch: number,
  ) {
    const release = this.options.allowance?.reserve(160 * 1024 * 1024);
    if (this.options.allowance && !release)
      throw new Error('No host memory capacity for a custom trigger worker');
    let handle: HuddleWorkerHandle;
    try {
      handle = startHuddleWorker(job, {
        ...this.options,
        cwd,
        timeoutMs: 10_000,
        request: async (request, signal) => {
          signal.throwIfAborted();
          if (epoch !== this.epoch || subscription.closing)
            throw new Error('Custom subscription was stopped');
          this.beforeAdmission();
          this.ledger.customTriggers.requireCurrent(source);
          const action = request.action;
          if (action.kind === 'trigger-emit') {
            const receipt = this.ledger.customTriggers.admit(
              source,
              action.emission,
              component,
              limits,
            );
            if (!receipt.duplicate) this.admitted();
            return receipt;
          }
          if (action.kind === 'trigger-checkpoint') {
            this.ledger.customTriggers.checkpoint(source, action.cursor);
            return null;
          }
          if (action.kind === 'trigger-health') {
            this.ledger.customTriggers.health(source, action.health);
            this.notify();
            if (action.health.state === 'gap' || action.health.state === 'closed') {
              subscription.closing = true;
              handle.cancel('Custom trigger reported ' + action.health.state);
            }
            return null;
          }
          throw new Error('Trigger workers cannot execute agent operations or node outputs');
        },
      });
    } catch (error) {
      release?.();
      throw error;
    }
    const subscription: Subscription = {
      source,
      handle,
      closing: false,
      settled: Promise.resolve(),
    };
    this.live.set(source.slot, subscription);
    const task = handle.result
      .then(() => {
        if (!subscription.closing)
          throw new Error('Custom trigger subscription ended unexpectedly');
      })
      .catch((error: unknown) => {
        try {
          if (!subscription.closing && epoch === this.epoch) this.failed(source, error);
          if (error instanceof HuddleWorkerTerminationUnknown) throw error;
        } catch (failure) {
          this.blocked = failure instanceof Error ? failure : new Error(String(failure));
          this.fatal(this.blocked);
          throw this.blocked;
        }
      })
      .finally(() => this.notify());
    const closed = Promise.allSettled([handle.exited, task]).then(() => {
      if (this.live.get(source.slot) === subscription) this.live.delete(source.slot);
      release?.();
      this.notify();
    });
    subscription.settled = task.then(() => closed);
    void subscription.settled.catch(() => {});
  }
}
