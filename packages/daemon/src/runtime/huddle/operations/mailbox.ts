import {
  HUDDLE_OPERATION_PAGE_LIMITS,
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
import type { RuntimeByteAllowance } from '../../resources/budget.js';
import { HuddlePendingOperations } from './pending.js';
import type { HuddleSpawnMailbox } from './spawns/mailbox.js';

/** Owner-owned asks wait here through controller loss. A consumed claim is never offered for dispatch again. */
export class HuddleOperationMailbox {
  private readonly pending: HuddlePendingOperations;
  constructor(
    private readonly identity: RuntimeIdentity,
    private readonly ledger: HuddleLedger,
    private readonly revisions: Pick<HuddleRevisionController, 'forExecution'>,
    private readonly changed: () => void,
    allowance?: RuntimeByteAllowance,
    private readonly spawns?: Pick<HuddleSpawnMailbox, 'target'>,
    pending?: HuddlePendingOperations,
  ) {
    this.pending = pending ?? new HuddlePendingOperations(ledger, changed, allowance);
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
    return this.pending.request(
      {
        id: message.id,
        invocationId: invocation.id,
        kind: 'ask',
        target,
        input: JSON.parse(JSON.stringify(operation.request)),
      },
      signal,
      this.identity,
    );
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
    const reference = operation.op === 'attach' ? operation.reference : operation.handle;
    const target = huddleBoundAgent(
      snapshot.components[invocation.node]!,
      activation,
      invocation.node,
      reference,
      this.spawns?.target(invocation, reference),
    );
    return { invocation, operation, target };
  }

  describe(id: string) {
    const operation = this.ledger.operations.get(id);
    if (operation.kind !== 'ask') throw new Error('Not an agent ask operation');
    const invocation = this.ledger.invocations.get(operation.invocationId);
    const execution = this.ledger.executions.get(operation.executionId);
    const { activation } = this.revisions.forExecution(operation.executionId);
    return huddleAgentOperationSchema.parse({
      scope: {
        // Legacy rows still belong to the immutable original launch. A recovery
        // path must preserve that identity, never infer it from a replacement.
        owner: this.ledger.operations.origin(operation.id) ?? this.identity,
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
    if (result.turn.status === 'completed')
      this.pending.resolve(scope.operationId, result.turn.reply!);
    else
      this.pending.reject(
        scope.operationId,
        new Error(result.turn.error ?? `Agent turn ${result.turn.status}`),
      );
    return result;
  }

  unavailable(scope: HuddleTurnScope, unsent: boolean, error: string) {
    const before = this.describe(scope.operationId);
    if (canonicalHuddleJson(scope) !== canonicalHuddleJson(before.scope))
      throw new Error('Host failure does not match its retained operation');
    if (unsent) this.ledger.operations.settle(scope.operationId, 'failed', { rejected: error });
    else this.ledger.operations.unknown(scope.operationId, error);
    this.changed();
    this.pending.reject(scope.operationId, new Error(error));
  }
}
