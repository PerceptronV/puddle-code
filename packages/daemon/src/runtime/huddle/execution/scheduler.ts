import { setImmediate } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  coreHuddleComponents,
  huddleEmissionRecordSchema,
  huddleExecutionRecordSchema,
  huddleInvocationRecordSchema,
  type HuddleExecutionRecord,
} from '@puddle/shared';
import { HuddleRevisionController } from '../control/revisions.js';
import { HuddleLedger } from '../state/ledger.js';
import { HuddleAttempts, type HuddleAttemptOptions } from './attempts.js';
import { huddleRecords } from './records.js';
import { HuddleExecutionContexts } from './contexts.js';

/** Event-driven owner scheduler. The owner invokes drain after durable admission/control changes. */
export class HuddleScheduler {
  private driving: Promise<void> | null = null;
  private notify = () => {};
  private readonly attempts: HuddleAttempts;
  private readonly contexts: HuddleExecutionContexts;
  constructor(
    private readonly ledger: HuddleLedger,
    revisions: HuddleRevisionController,
    options: HuddleAttemptOptions,
  ) {
    this.contexts = new HuddleExecutionContexts(ledger, revisions, options.allowance);
    this.attempts = new HuddleAttempts(
      ledger,
      this.contexts,
      options,
      () => this.notify(),
      (id, error) => this.fail(id, error),
    );
  }
  get hasLiveWorkers() {
    return this.attempts.size > 0;
  }

  observeReadout(operationId: string): void {
    try {
      this.attempts.observeReadout(operationId);
    } finally {
      this.contexts.prune();
    }
  }

  drain(): Promise<void> {
    this.notify();
    if (!this.driving)
      this.driving = this.loop().finally(() => {
        this.driving = null;
      });
    return this.driving;
  }

  async halt(intent: 'stopped' | 'interrupted', reason: string): Promise<void> {
    const current = this.ledger.activations.current();
    this.ledger.activations.setIntent(current.generation, intent, current.autoStart);
    this.attempts.cancelAll(reason);
    for (const execution of this.executions()) {
      this.attempts.cancel(execution.id, reason);
      this.ledger.interrupt(
        execution.id,
        execution.state === 'pending' ? 'cancelled' : 'interrupted',
        reason.slice(0, 4096),
      );
    }
    await this.drain();
  }

  private async loop() {
    for (;;) {
      const notified = new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      if (this.attempts.blocked) throw this.attempts.blocked;
      const progressed = this.step();
      this.contexts.prune();
      if (progressed) {
        await setImmediate();
        continue;
      }
      if (!this.attempts.size) return;
      const nextDeadline = Math.min(...this.executions().map((execution) => execution.deadline));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => {
        if (Number.isFinite(nextDeadline))
          timer = setTimeout(resolve, Math.max(1, nextDeadline - Date.now()));
      });
      try {
        await Promise.race([notified, expired, ...this.attempts.pending]);
      } finally {
        clearTimeout(timer);
      }
      await setImmediate();
    }
  }

  private step(): boolean {
    let progressed = false;
    const executions = this.executions();
    let running = executions.filter((execution) => execution.state === 'running').length;
    const armed = this.ledger.activations.current().state === 'armed';
    for (const execution of executions) {
      try {
        if (Date.now() >= execution.deadline) throw new Error('Huddle execution deadline exceeded');
        if (!armed) continue;
        if (execution.state === 'pending') {
          if (running >= execution.limits.concurrency) continue;
          const { snapshot, graph } = this.contexts.forExecution(execution.id);
          for (const node of snapshot.definition.nodes) {
            const component = snapshot.components[node.id]!;
            if (node.source.kind === 'builtin') {
              const builtin = coreHuddleComponents.get(
                `${node.source.component}@${node.source.version}`,
              );
              if (
                !builtin ||
                canonicalHuddleJson(JSON.parse(JSON.stringify(builtin))) !==
                  canonicalHuddleJson(JSON.parse(JSON.stringify(component)))
              )
                throw new Error('Unsupported captured built-in component');
            }
          }
          graph.start(execution.id);
          running++;
          progressed = true;
        }
      } catch (error) {
        this.fail(execution.id, error);
        progressed = true;
      }
    }
    for (const emission of huddleRecords(this.ledger, 'emissions', huddleEmissionRecordSchema, {
      state: 'pending',
    })) {
      if (!armed) break;
      try {
        const { graph } = this.contexts.forExecution(emission.executionId);
        graph.route(emission.invocationId, emission.sequence);
      } catch (error) {
        this.fail(emission.executionId, error);
      }
      progressed = true;
    }
    for (const invocation of huddleRecords(
      this.ledger,
      'invocations',
      huddleInvocationRecordSchema,
      { state: 'pending' },
    )) {
      if (!armed) break;
      if (this.ledger.executions.get(invocation.executionId).state !== 'running') continue;
      try {
        progressed = this.attempts.start(invocation) || progressed;
      } catch (error) {
        this.fail(invocation.executionId, error);
        progressed = true;
      }
    }
    for (const execution of this.executions().filter(
      (execution) => execution.state === 'running',
    )) {
      if (
        this.ledger.page('invocations', { parent: execution.id, state: 'pending' }).length ||
        this.ledger.page('invocations', { parent: execution.id, state: 'running' }).length ||
        this.ledger.page('emissions', { parent: execution.id, state: 'pending' }).length
      )
        continue;
      try {
        if (this.ledger.page('joins', { parent: execution.id, state: 'waiting' }).length)
          throw new Error('Required join inputs were never produced');
        this.ledger.executions.finish(execution.id, 'completed');
      } catch (error) {
        this.fail(execution.id, error);
      }
      progressed = true;
    }
    return progressed;
  }

  private executions(): HuddleExecutionRecord[] {
    return ['pending', 'running'].flatMap((state) => [
      ...huddleRecords(this.ledger, 'executions', huddleExecutionRecordSchema, { state }),
    ]);
  }
  private fail(id: string, error: unknown) {
    const record = this.ledger.executions.get(id);
    if (!['pending', 'running'].includes(record.state)) return;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
    this.attempts.cancel(id, reason);
    this.ledger.interrupt(id, 'failed', reason);
  }
}
