import {
  canonicalHuddleJson,
  decodeHuddleLifecycleTarget,
  huddleLifecycleOperationSchema,
  huddleLifecyclePageSchema,
  huddleLifecycleRequestSchema,
  huddleOperationRecordSchema,
  huddleSpawnOutcomeSchema,
  huddleSpawnScopeSchema,
  HUDDLE_OPERATION_PAGE_LIMITS,
  type HuddleInvocationRecord,
  type HuddleWorkerRequest,
  type RuntimeIdentity,
  type HuddleSpawnScope,
  type HuddleSpawnOutcome,
} from '@puddle/shared';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionController } from '../../control/revisions.js';
import type { HuddlePendingOperations } from '../pending.js';
import { huddleAgentWorktree } from '../bindings.js';
import { huddleLifecycleReceipt } from '../../../../huddle/operations/lifecycle/receipt.js';

export class HuddleLifecycleMailbox {
  constructor(
    private readonly identity: RuntimeIdentity,
    private readonly ledger: HuddleLedger,
    private readonly revisions: Pick<HuddleRevisionController, 'forExecution'>,
    private readonly changed: () => void,
    private readonly pending: HuddlePendingOperations,
  ) {}
  request(message: HuddleWorkerRequest, expected: HuddleInvocationRecord, signal: AbortSignal) {
    signal.throwIfAborted();
    const invocation = this.ledger.invocations.get(expected.id);
    this.ledger.executions.requireRunning(invocation.executionId);
    if (
      invocation.state !== 'running' ||
      invocation.executionId !== expected.executionId ||
      message.action.kind !== 'operation' ||
      !['resume', 'restart'].includes(message.action.operation.op)
    )
      throw new Error('Lifecycle invocation is unavailable');
    const operation = message.action.operation;
    if (operation.op !== 'resume' && operation.op !== 'restart')
      throw new Error('Not a lifecycle action');
    const { activation, snapshot } = this.revisions.forExecution(invocation.executionId);
    const component = snapshot.components[invocation.node]!;
    const worktree = huddleAgentWorktree(component, activation, invocation.node);
    if (component.lifecycle !== operation.op)
      throw new Error('Node did not declare this lifecycle action');
    const bindings = activation.bindings[invocation.node] ?? {};
    const targets = Object.entries(component.parameters).flatMap(([name, parameter]) => {
      if (parameter.editor !== 'session' || !bindings[name]) return [];
      const target = decodeHuddleLifecycleTarget(bindings[name]);
      return [bindings[name], target.sessionId].includes(operation.reference) ? [target] : [];
    });
    if (
      targets.length !== 1 ||
      targets[0]!.worktree !== worktree ||
      targets[0]!.projectId !== this.identity.project_id
    )
      throw new Error('Choose one declared lifecycle session in its explicit worktree');
    const request = huddleLifecycleRequestSchema.parse({
      action: operation.op,
      target: targets[0],
    });
    return this.pending.request(
      {
        id: message.id,
        invocationId: invocation.id,
        kind: operation.op,
        target: request.target,
        input: request,
      },
      signal,
      this.identity,
    );
  }
  describe(id: string) {
    const record = this.ledger.operations.get(id);
    if (record.kind !== 'resume' && record.kind !== 'restart')
      throw new Error('Not a lifecycle operation');
    const invocation = this.ledger.invocations.get(record.invocationId);
    const execution = this.ledger.executions.get(record.executionId);
    const { activation } = this.revisions.forExecution(record.executionId);
    const request = huddleLifecycleRequestSchema.parse(record.input);
    if (
      request.action !== record.kind ||
      canonicalHuddleJson(request.target) !== canonicalHuddleJson(record.target)
    )
      throw new Error('Lifecycle request differs from retained intent');
    return huddleLifecycleOperationSchema.parse({
      scope: {
        owner: this.ledger.operations.origin(id) ?? this.identity,
        executionId: execution.id,
        invocationId: invocation.id,
        operationId: id,
        activationId: activation.id,
        revision: execution.revision,
      },
      node: invocation.node,
      request,
      deadline: execution.deadline,
      active:
        execution.state === 'running' &&
        invocation.state === 'running' &&
        Date.now() < execution.deadline,
      state: record.state,
      ...(record.result === undefined ? {} : { result: record.result }),
    });
  }
  page(after: number) {
    let next = after;
    const records: Array<{
      ordinal: number;
      operation: ReturnType<HuddleLifecycleMailbox['describe']>;
    }> = [];
    for (const row of this.ledger.page('operations', { after })) {
      const record = huddleOperationRecordSchema.parse(JSON.parse(row.body));
      if (record.kind !== 'resume' && record.kind !== 'restart') {
        next = row.ordinal;
        continue;
      }
      const operation = this.describe(record.id);
      if (
        !huddleLifecyclePageSchema.safeParse({
          records: [...records, { ordinal: row.ordinal, operation }],
          next: row.ordinal,
        }).success
      ) {
        if (!records.length) throw new Error('Lifecycle operation exceeds page limit');
        break;
      }
      records.push({ ordinal: row.ordinal, operation });
      next = row.ordinal;
      if (records.length === HUDDLE_OPERATION_PAGE_LIMITS.records) break;
    }
    return huddleLifecyclePageSchema.parse({ records, next });
  }
  claim(id: string) {
    const before = this.describe(id);
    if (before.state !== 'prepared') return { dispatch: false, operation: before };
    if (!before.active || !this.pending.has(id)) throw new Error('Lifecycle invocation ended');
    this.ledger.operations.dispatch(id);
    this.changed();
    return { dispatch: true, operation: this.describe(id) };
  }
  private scoped(raw: HuddleSpawnScope) {
    const scope = huddleSpawnScopeSchema.parse(raw),
      before = this.describe(scope.operationId);
    if (canonicalHuddleJson(scope) !== canonicalHuddleJson(before.scope))
      throw new Error('Lifecycle scope changed');
    return before;
  }
  settle(scope: HuddleSpawnScope, raw: HuddleSpawnOutcome) {
    const before = this.scoped(scope),
      result = huddleSpawnOutcomeSchema.parse(raw);
    const target = before.request.target;
    if (
      result.agent.sessionId !== target.sessionId ||
      result.agent.projectId !== target.projectId ||
      result.agent.worktree !== target.worktree ||
      result.receipt !== huddleLifecycleReceipt(before.scope, before.request, result.agent)
    )
      throw new Error('Lifecycle outcome differs from retained target');
    this.ledger.operations.settle(scope.operationId, 'completed', result);
    this.changed();
    this.pending.resolve(scope.operationId, {
      runtime_id: result.agent.runtimeId,
      session_id: result.agent.sessionId,
    });
    return result;
  }
  unavailable(scope: HuddleSpawnScope, unsent: boolean, error: string) {
    this.scoped(scope);
    if (unsent) {
      this.ledger.operations.settle(scope.operationId, 'failed', { rejected: error });
      this.pending.reject(scope.operationId, new Error(error));
    } else {
      this.ledger.operations.unknown(scope.operationId, error);
      this.pending.reject(scope.operationId, new Error(error));
    }
    this.changed();
  }
}
