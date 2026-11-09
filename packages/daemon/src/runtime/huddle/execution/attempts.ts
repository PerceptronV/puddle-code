import {
  huddleInvocationRecordSchema,
  validateHuddleValue,
  type HuddleInvocationRecord,
  type HuddleWorkerRequest,
  type HuddleJson,
  type HuddleRevisionActivation,
  type HuddleNodeDefinition,
  type HuddleComponent,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';
import { prepareHuddleWorkerJob } from '../../../huddle/definitions/worker.js';
import { HuddleRevisionController } from '../control/revisions.js';
import { HuddleLedger } from '../state/ledger.js';
import {
  startHuddleWorker,
  HuddleWorkerTerminationUnknown,
  type HuddleWorkerHandle,
  type HuddleWorkerOptions,
} from '../workers/process.js';
import { huddleRecords } from './records.js';
import { HuddleReadoutDelivery } from '../readouts/delivery.js';
import { prepareReadoutObservation } from '../readouts/observation.js';

export interface HuddleAttemptOptions extends Pick<
  HuddleWorkerOptions,
  'secrets' | 'nodePath' | 'entryPath' | 'environment' | 'allowance'
> {
  maxWorkers?: number;
  /** Host implementation must revalidate scope and use the ledger before external dispatch. */
  operation?(
    request: HuddleWorkerRequest,
    invocation: HuddleInvocationRecord,
    signal: AbortSignal,
  ): Promise<HuddleJson>;
  log?(invocation: string, stream: 'stdout' | 'stderr', text: string): void;
}

export class HuddleAttempts {
  private readonly live = new Map<
    string,
    { executionId: string; handle: HuddleWorkerHandle; task: Promise<void> }
  >();
  private readonly maxWorkers: number;
  blocked: Error | null = null;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: Pick<HuddleRevisionController, 'forExecution'>,
    private readonly options: HuddleAttemptOptions,
    private readonly wake: () => void,
    private readonly failed: (id: string, error: Error) => void,
  ) {
    this.maxWorkers = options.maxWorkers ?? 4;
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 16)
      throw new Error('Invalid huddle worker concurrency');
    if (ledger.page('invocations', { state: 'running' }).length)
      throw new Error('Fence and recover previous huddle workers before scheduling');
  }
  get size() {
    return this.live.size;
  }
  get pending() {
    return [...this.live.values()].map((item) => item.task);
  }

  observeReadout(operationId: string): void {
    if (this.blocked) throw this.blocked;
    if (this.live.has(operationId) || this.live.size >= this.maxWorkers)
      throw new Error('Huddle observation is already running or worker capacity is unavailable');
    const observation = prepareReadoutObservation(this.ledger, this.revisions, operationId);
    const releaseWorker = this.options.allowance?.reserve(160 * 1024 * 1024);
    if (this.options.allowance && !releaseWorker)
      throw new Error('Host memory admission is unavailable for a huddle worker');
    let handle: HuddleWorkerHandle;
    try {
      this.ledger.operations.unknown(
        operationId,
        'An observation was requested; delivery remains unknown until a receipt is retained',
      );
      handle = startHuddleWorker(observation.job, {
        ...this.options,
        cwd: observation.worktree,
        timeoutMs: 30_000,
        request: observation.request,
        log: (stream, text) => this.options.log?.(observation.invocation.id, stream, text),
      });
    } catch (error) {
      releaseWorker?.();
      throw error;
    }
    const task = handle.result
      .then(() => {})
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (failure instanceof HuddleWorkerTerminationUnknown) this.blocked = failure;
        try {
          observation.failed(failure);
        } catch (error) {
          this.blocked = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      })
      .finally(() => this.wake());
    this.live.set(operationId, {
      executionId: observation.invocation.executionId,
      handle,
      task,
    });
    void Promise.allSettled([handle.exited, task]).then(() => {
      this.live.delete(operationId);
      releaseWorker?.();
      this.wake();
    });
  }

  cancelAll(reason: string) {
    for (const item of this.live.values()) item.handle.cancel(reason);
  }

  start(invocation: HuddleInvocationRecord): boolean {
    if (this.blocked) return false;
    const { activation, snapshot } = this.revisions.forExecution(invocation.executionId);
    const node = snapshot.definition.nodes.find((node) => node.id === invocation.node)!;
    const component = snapshot.components[node.id]!;
    let running = 0;
    for (const other of huddleRecords(this.ledger, 'invocations', huddleInvocationRecordSchema, {
      state: 'running',
    }))
      if (other.revision === invocation.revision && other.node === invocation.node) running++;
    if (running >= node.concurrency) return false;
    if (node.source.kind === 'builtin' && node.source.component === 'puddle.readout.result') {
      this.ledger.invocations.start(invocation.id, Date.now(), node.concurrency);
      this.ledger.invocations.complete(invocation.id, {});
      return true;
    }
    if (this.live.size >= this.maxWorkers) return false;
    // Retain a managed child allowance through positive exit, including unknown results.
    // This covers the configured heap plus overhead; it is not an OS RSS limit.
    const releaseWorker = this.options.allowance?.reserve(160 * 1024 * 1024);
    if (this.options.allowance && !releaseWorker)
      throw new Error('Host memory admission is unavailable for a huddle worker');
    try {
      return this.spawn(invocation, activation, snapshot, node, component, releaseWorker);
    } catch (error) {
      releaseWorker?.();
      throw error;
    }
  }

  private spawn(
    invocation: HuddleInvocationRecord,
    activation: HuddleRevisionActivation,
    snapshot: HuddleDefinitionSnapshot,
    node: HuddleNodeDefinition,
    component: HuddleComponent,
    releaseWorker: (() => void) | null | undefined,
  ): boolean {
    const readout =
      component.category === 'readout'
        ? new HuddleReadoutDelivery(this.ledger, invocation, component)
        : undefined;
    const job = prepareHuddleWorkerJob(
      snapshot,
      invocation,
      activation.variables,
      activation.bindings[node.id] ?? {},
      readout ? { delivery: readout.envelope, mode: 'deliver' } : undefined,
    );
    const execution = this.ledger.executions.requireRunning(invocation.executionId);
    this.ledger.invocations.start(invocation.id, Date.now(), node.concurrency);
    let handle: HuddleWorkerHandle;
    try {
      readout?.dispatch();
      handle = startHuddleWorker(job, {
        ...this.options,
        cwd: activation.worktree,
        timeoutMs: Math.max(1, execution.deadline - Date.now()),
        request: async (message, signal) => {
          this.ledger.executions.requireRunning(invocation.executionId);
          signal.throwIfAborted();
          if (message.action.kind === 'readout-result') {
            if (!readout) throw new Error('Script workers cannot settle external readouts');
            readout.accept(message.action.result);
            return null;
          }
          if (message.action.kind === 'operation') {
            if (component.hostTrigger)
              throw new Error(
                'Host trigger adapters emit data; connect a script node for agent operations',
              );
            if (!this.options.operation)
              throw new Error('Huddle host operation bridge is unavailable');
            return this.options.operation(message, invocation, signal);
          }
          if (message.action.kind !== 'emit')
            throw new Error('Node workers cannot control trigger subscriptions');
          const { port, value, sequence } = message.action;
          if (readout) throw new Error('Readout outputs require confirmed delivery');
          const contract = component.outputs[port];
          if (contract?.emission !== 'event' || validateHuddleValue(contract.schema, value).length)
            throw new Error('Invalid worker event port');
          this.ledger.invocations.emit(invocation.id, sequence, port, value);
          this.wake();
          return null;
        },
        log: (stream, text) => this.options.log?.(invocation.id, stream, text),
      });
    } catch (error) {
      releaseWorker?.();
      this.failed(
        invocation.executionId,
        error instanceof Error ? error : new Error(String(error)),
      );
      return true;
    }
    const task = handle.result
      .then((outputs) => {
        if (this.ledger.executions.get(invocation.executionId).state === 'running') {
          readout?.requireDelivered(outputs);
          this.ledger.invocations.complete(invocation.id, outputs);
        }
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (failure instanceof HuddleWorkerTerminationUnknown) this.blocked = failure;
        try {
          this.failed(invocation.executionId, failure);
        } catch (error) {
          this.blocked = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      })
      .finally(() => this.wake());
    this.live.set(invocation.id, { executionId: invocation.executionId, handle, task });
    // A result can be unknown while the child remains alive. Retain that handle until positive exit.
    void Promise.allSettled([handle.exited, task]).then(() => {
      this.live.delete(invocation.id);
      releaseWorker?.();
      this.wake();
    });
    return true;
  }

  cancel(executionId: string, reason: string) {
    for (const item of this.live.values())
      if (item.executionId === executionId) item.handle.cancel(reason);
  }
}
