import {
  HUDDLE_OPERATION_PAGE_LIMITS,
  HUDDLE_WORKER_LIMITS,
  canonicalHuddleJson,
  huddleAgentOperationSchema,
  huddleAgentOutcomeSchema,
  huddleAgentTargetSchema,
  huddleOperationPageSchema,
  huddleOperationRecordSchema,
  huddleTurnScopeSchema,
  puddlangAskSchema,
  type HuddleAgentOutcome,
  type HuddleJson,
  type HuddleWorkerRequest,
  type HuddleInvocationRecord,
  type HuddleTurnScope,
  type RuntimeIdentity,
} from '@puddle/shared';
import type { HuddleLedger } from '../state/ledger.js';
import type { HuddleRevisionController } from '../control/revisions.js';
import { huddleBoundAgent } from './bindings.js';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../resources/budget.js';
import { runtimeJsonRetainedBytes } from '../../transport/encoding.js';

/** Owner-owned asks wait here through controller loss. A consumed claim is never offered for dispatch again. */
export class HuddleOperationMailbox {
  private readonly budget: RuntimeBufferBudget;
  private readonly pending = new Map<
    string,
    { resolve(value: HuddleJson): void; reject(error: Error): void }
  >();
  constructor(
    private readonly identity: RuntimeIdentity,
    private readonly ledger: HuddleLedger,
    private readonly revisions: Pick<HuddleRevisionController, 'forExecution'>,
    private readonly changed: () => void,
    allowance?: RuntimeByteAllowance,
  ) {
    this.budget = new RuntimeBufferBudget(
      { bytes: 16 * 1024 * 1024, count: HUDDLE_WORKER_LIMITS.pending },
      allowance,
    );
  }

  async request(
    message: HuddleWorkerRequest,
    expected: HuddleInvocationRecord,
    signal: AbortSignal,
  ): Promise<HuddleJson> {
    signal.throwIfAborted();
    const { invocation, operation, target } = this.binding(message, expected);
    if (operation.op === 'attach')
      return { runtime_id: target.runtimeId, session_id: target.sessionId };
    return this.ask(message.id, invocation, target, operation.request, signal);
  }

  // Keep the captured source out of the asynchronous request's retained state.
  private binding(message: HuddleWorkerRequest, expected: HuddleInvocationRecord) {
    const invocation = this.ledger.invocations.get(expected.id);
    this.ledger.executions.requireRunning(invocation.executionId);
    if (
      invocation.state !== 'running' ||
      invocation.executionId !== expected.executionId ||
      message.action.kind !== 'operation'
    )
      throw new Error('Huddle invocation is no longer available');
    const { activation, snapshot } = this.revisions.forExecution(invocation.executionId);
    const operation = message.action.operation;
    if (operation.op !== 'attach' && operation.op !== 'ask')
      throw new Error('This huddle bridge supports attach and ask only');
    const target = huddleBoundAgent(
      snapshot.components[invocation.node]!,
      activation,
      invocation.node,
      operation.op === 'attach' ? operation.reference : operation.handle,
    );
    return { invocation, operation, target };
  }

  private async ask(
    id: string,
    invocation: HuddleInvocationRecord,
    target: ReturnType<typeof huddleBoundAgent>,
    request: ReturnType<typeof puddlangAskSchema.parse>,
    signal: AbortSignal,
  ): Promise<HuddleJson> {
    if (this.pending.size >= HUDDLE_WORKER_LIMITS.pending)
      throw new Error('Huddle host-operation queue is full');
    if (this.pending.has(id)) throw new Error('Huddle operation is already waiting');
    const release = this.budget.reserve(runtimeJsonRetainedBytes({ request, target }) + 16_384);
    if (!release) throw new Error('Host memory admission is unavailable for a huddle operation');
    let cancelled = () => {};
    try {
      const intent = this.ledger.operations.prepare({
        id,
        invocationId: invocation.id,
        kind: 'ask',
        target,
        input: JSON.parse(JSON.stringify(request)),
      });
      if (intent.duplicate)
        throw new Error('Observe the retained operation instead of repeating a worker request');
      return await new Promise<HuddleJson>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        cancelled = () => {
          try {
            const record = this.ledger.operations.get(id);
            if (record.state === 'prepared') this.ledger.operations.cancelUnsent(record.id);
            else if (record.state === 'dispatched')
              this.ledger.operations.unknown(
                record.id,
                'Node stopped while awaiting host operation',
              );
            this.changed();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('Huddle operation cancelled'),
          );
        };
        signal.addEventListener('abort', cancelled, { once: true });
        this.changed();
      });
    } finally {
      signal.removeEventListener('abort', cancelled);
      this.pending.delete(id);
      release();
    }
  }

  describe(id: string) {
    const operation = this.ledger.operations.get(id);
    if (operation.kind !== 'ask') throw new Error('Not an agent ask operation');
    const invocation = this.ledger.invocations.get(operation.invocationId);
    const execution = this.ledger.executions.get(operation.executionId);
    const { activation } = this.revisions.forExecution(operation.executionId);
    return huddleAgentOperationSchema.parse({
      scope: {
        owner: this.identity,
        executionId: execution.id,
        invocationId: invocation.id,
        operationId: operation.id,
        activationId: activation.id,
        revision: execution.revision,
        target: huddleAgentTargetSchema.parse(operation.target),
      },
      node: invocation.node,
      request: puddlangAskSchema.parse(operation.input),
      deadline: execution.deadline,
      active:
        execution.state === 'running' &&
        invocation.state === 'running' &&
        Date.now() < execution.deadline,
      state: operation.state,
      ...(operation.result === undefined ? {} : { result: operation.result }),
    });
  }

  page(after: number) {
    let next = after;
    const records: Array<{
      ordinal: number;
      operation: ReturnType<HuddleOperationMailbox['describe']>;
    }> = [];
    for (const row of this.ledger.page('operations', { after })) {
      const record = huddleOperationRecordSchema.parse(JSON.parse(row.body));
      if (record.kind !== 'ask') {
        next = row.ordinal;
        continue;
      }
      const operation = this.describe(record.id);
      const candidate = {
        records: [...records, { ordinal: row.ordinal, operation }],
        next: row.ordinal,
      };
      if (!huddleOperationPageSchema.safeParse(candidate).success) {
        if (!records.length) throw new Error('Operation cannot fit in a bounded owner page');
        break;
      }
      records.push({ ordinal: row.ordinal, operation });
      next = row.ordinal;
      if (records.length === HUDDLE_OPERATION_PAGE_LIMITS.records) break;
    }
    return huddleOperationPageSchema.parse({ records, next });
  }

  claim(id: string) {
    const before = this.describe(id);
    if (before.state !== 'prepared') return { dispatch: false, operation: before };
    if (!before.active || !this.pending.has(id))
      throw new Error('The node is no longer awaiting this operation');
    this.ledger.operations.dispatch(id);
    this.changed();
    return { dispatch: true, operation: this.describe(id) };
  }

  settle(rawScope: HuddleTurnScope, rawResult: HuddleAgentOutcome) {
    const scope = huddleTurnScopeSchema.parse(rawScope);
    const result = huddleAgentOutcomeSchema.parse(rawResult);
    const before = this.describe(scope.operationId);
    if (canonicalHuddleJson(scope) !== canonicalHuddleJson(before.scope))
      throw new Error('Host result does not match its retained huddle operation');
    this.ledger.operations.settle(
      scope.operationId,
      result.turn.status === 'completed' ? 'completed' : 'failed',
      result,
    );
    // Durable ledger storage precedes both the worker reply and the host receipt response.
    this.changed();
    const waiting = this.pending.get(scope.operationId);
    if (result.turn.status === 'completed') waiting?.resolve(result.turn.reply!);
    else waiting?.reject(new Error(result.turn.error ?? `Agent turn ${result.turn.status}`));
    return result;
  }

  unavailable(scope: HuddleTurnScope, unsent: boolean, error: string) {
    const before = this.describe(scope.operationId);
    if (canonicalHuddleJson(scope) !== canonicalHuddleJson(before.scope))
      throw new Error('Host failure does not match its retained operation');
    if (unsent) this.ledger.operations.settle(scope.operationId, 'failed', { rejected: error });
    else this.ledger.operations.unknown(scope.operationId, error);
    this.changed();
    this.pending.get(scope.operationId)?.reject(new Error(error));
  }
}
