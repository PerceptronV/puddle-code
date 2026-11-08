import { huddleLifecycleRequestSchema } from '@puddle/shared';
import { huddleLifecycleReceipt } from '../../../../huddle/operations/lifecycle/receipt.js';
import {
  HUDDLE_OPERATION_PAGE_LIMITS,
  canonicalHuddleJson,
  encodeHuddleAgentTarget,
  huddleOperationRecordSchema,
  huddleSpawnOperationSchema,
  huddleSpawnOutcomeSchema,
  huddleSpawnPageSchema,
  huddleSpawnRequestSchema,
  huddleSpawnRejectionSchema,
  huddleSpawnScopeSchema,
  type HuddleAgentTarget,
  type HuddleInvocationRecord,
  type HuddleSpawnOutcome,
  type HuddleSpawnScope,
  type HuddleSpawnCleanupOutcome,
  type HuddleWorkerRequest,
  type RuntimeIdentity,
} from '@puddle/shared';
import type { HuddleLedger } from '../../state/ledger.js';
import type { HuddleRevisionController } from '../../control/revisions.js';
import { HuddlePendingOperations } from '../pending.js';
import { huddleBoundSpawn } from './bindings.js';
import { huddleSpawnReceipt } from '../../../../huddle/operations/spawns/receipt.js';

/** Owner-local spawn outbox. Only a fresh consumed claim permits host creation. */
export class HuddleSpawnMailbox {
  private cleanupWaiter?: { promise: Promise<void>; resolve(): void };
  constructor(
    private readonly identity: RuntimeIdentity,
    private readonly ledger: HuddleLedger,
    private readonly revisions: Pick<HuddleRevisionController, 'forExecution'>,
    private readonly changed: () => void,
    private readonly pending: HuddlePendingOperations,
  ) {}

  async request(
    message: HuddleWorkerRequest,
    expected: HuddleInvocationRecord,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const invocation = this.ledger.invocations.get(expected.id);
    this.ledger.executions.requireRunning(invocation.executionId);
    if (
      invocation.state !== 'running' ||
      invocation.executionId !== expected.executionId ||
      message.action.kind !== 'operation' ||
      message.action.operation.op !== 'spawn'
    )
      throw new Error('Huddle spawn invocation is no longer available');
    const { activation, snapshot } = this.revisions.forExecution(invocation.executionId);
    const component = snapshot.components[invocation.node]!;
    if (!component || !['script', 'readout'].includes(component.category))
      throw new Error('Only script/readout invocations can spawn agents');
    const request = huddleBoundSpawn(
      component,
      activation,
      invocation.node,
      this.identity.project_id,
      message.action.operation.options,
    );
    return this.pending.request(
      {
        id: message.id,
        invocationId: invocation.id,
        kind: 'spawn',
        target: { projectId: request.projectId, worktree: request.worktree },
        input: request,
      },
      signal,
      this.identity,
    );
  }

  describe(id: string) {
    const operation = this.ledger.operations.get(id);
    if (operation.kind !== 'spawn') throw new Error('Not an agent spawn operation');
    const invocation = this.ledger.invocations.get(operation.invocationId);
    const execution = this.ledger.executions.get(operation.executionId);
    const { activation } = this.revisions.forExecution(operation.executionId);
    const request = huddleSpawnRequestSchema.parse(operation.input);
    if (
      canonicalHuddleJson(operation.target) !==
      canonicalHuddleJson({
        projectId: request.projectId,
        worktree: request.worktree,
      })
    )
      throw new Error('Spawn target differs from its retained request');
    return huddleSpawnOperationSchema.parse({
      scope: {
        // Legacy rows still belong to the immutable original launch. A recovery
        // path must preserve that identity, never infer it from a replacement.
        owner: this.ledger.operations.origin(operation.id) ?? this.identity,
        executionId: execution.id,
        invocationId: invocation.id,
        operationId: operation.id,
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
      state: operation.state,
      cleanup: this.ledger.spawnCleanup.get(id),
      ...(operation.result === undefined ? {} : { result: operation.result }),
    });
  }

  page(after: number) {
    let next = after;
    const records: Array<{
      ordinal: number;
      operation: ReturnType<HuddleSpawnMailbox['describe']>;
    }> = [];
    for (const row of this.ledger.page('operations', { after })) {
      const record = huddleOperationRecordSchema.parse(JSON.parse(row.body));
      if (record.kind !== 'spawn') {
        next = row.ordinal;
        continue;
      }
      const operation = this.describe(record.id);
      const candidate = {
        records: [...records, { ordinal: row.ordinal, operation }],
        next: row.ordinal,
      };
      if (!huddleSpawnPageSchema.safeParse(candidate).success) {
        if (!records.length) throw new Error('Spawn cannot fit in a bounded owner page');
        break;
      }
      records.push({ ordinal: row.ordinal, operation });
      next = row.ordinal;
      if (records.length === HUDDLE_OPERATION_PAGE_LIMITS.records) break;
    }
    return huddleSpawnPageSchema.parse({ records, next });
  }

  claim(id: string) {
    const before = this.describe(id);
    if (before.state !== 'prepared') return { dispatch: false, operation: before };
    if (!before.active || !this.pending.has(id) || before.cleanup.state !== 'retained')
      throw new Error('The node is no longer awaiting this spawn');
    this.ledger.operations.dispatch(id);
    this.changed();
    return { dispatch: true, operation: this.describe(id) };
  }

  private scoped(raw: HuddleSpawnScope) {
    const scope = huddleSpawnScopeSchema.parse(raw);
    const before = this.describe(scope.operationId);
    if (canonicalHuddleJson(scope) !== canonicalHuddleJson(before.scope))
      throw new Error('Host result does not match its retained huddle spawn');
    return before;
  }

  settle(scope: HuddleSpawnScope, raw: HuddleSpawnOutcome) {
    const before = this.scoped(scope);
    const result = huddleSpawnOutcomeSchema.parse(raw);
    this.verify(before, result);
    this.ledger.operations.settle(before.scope.operationId, 'completed', result);
    this.changed();
    this.pending.resolve(before.scope.operationId, {
      runtime_id: result.agent.runtimeId,
      session_id: result.agent.sessionId,
    });
    return result;
  }

  unavailable(scope: HuddleSpawnScope, unsent: boolean, error: string) {
    const before = this.scoped(scope);
    const failure = huddleSpawnRejectionSchema.parse({ rejected: error });
    if (unsent) this.ledger.operations.settle(before.scope.operationId, 'failed', failure);
    else this.ledger.operations.unknown(before.scope.operationId, error);
    this.changed();
    this.pending.reject(before.scope.operationId, new Error(error));
  }

  get cleanupPending() {
    return this.ledger.spawnCleanup.pending > 0;
  }
  waitForCleanup(): Promise<void> {
    if (!this.cleanupPending) return Promise.resolve();
    if (!this.cleanupWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.cleanupWaiter = { promise, resolve };
    }
    return this.cleanupWaiter.promise;
  }
  cleanupSettle(scope: HuddleSpawnScope, outcome: HuddleSpawnCleanupOutcome) {
    const before = this.scoped(scope);
    if (before.state === 'completed' && outcome !== 'stopped')
      throw new Error('A ready agent requires confirmed runtime shutdown');
    const changed = this.ledger.spawnCleanup.settle(scope.operationId, outcome);
    if (!this.cleanupPending) {
      this.cleanupWaiter?.resolve();
      this.cleanupWaiter = undefined;
    }
    if (changed) this.changed();
  }
  cleanupUnavailable(scope: HuddleSpawnScope, error: string) {
    this.scoped(scope);
    if (this.ledger.spawnCleanup.unavailable(scope.operationId, error)) this.changed();
  }

  /** Spawn/lifecycle results can cross nodes in one execution; this grants no cleanup ownership. */
  target(
    invocation: HuddleInvocationRecord,
    reference: string | { runtime_id: string; session_id: string },
  ): HuddleAgentTarget | null {
    const current = this.ledger.invocations.get(invocation.id);
    this.ledger.executions.requireRunning(current.executionId);
    if (current.state !== 'running' || current.executionId !== invocation.executionId)
      throw new Error('Huddle invocation is no longer available');
    const matches = new Map<string, HuddleAgentTarget>();
    let after = 0;
    for (;;) {
      const rows = this.ledger.page('operations', {
        parent: current.executionId,
        state: 'completed',
        after,
      });
      if (!rows.length) break;
      for (const row of rows) {
        after = row.ordinal;
        const operation = huddleOperationRecordSchema.parse(JSON.parse(row.body));
        if (!['spawn', 'resume', 'restart'].includes(operation.kind)) continue;
        const result = huddleSpawnOutcomeSchema.parse(operation.result);
        if (operation.kind === 'spawn') this.verify(this.describe(operation.id), result);
        else {
          const request = huddleLifecycleRequestSchema.parse(operation.input);
          const { activation } = this.revisions.forExecution(operation.executionId);
          const scope = {
            owner: this.ledger.operations.origin(operation.id) ?? this.identity,
            executionId: operation.executionId,
            invocationId: operation.invocationId,
            operationId: operation.id,
            activationId: activation.id,
            revision: this.ledger.executions.get(operation.executionId).revision,
          };
          if (
            result.agent.sessionId !== request.target.sessionId ||
            result.receipt !== huddleLifecycleReceipt(scope, request, result.agent)
          )
            throw new Error('Lifecycle agent differs from retained readiness');
        }
        const target = result.agent;
        const selected =
          typeof reference === 'string'
            ? [target.runtimeId, target.sessionId, encodeHuddleAgentTarget(target)].includes(
                reference,
              )
            : reference.runtime_id === target.runtimeId &&
              reference.session_id === target.sessionId;
        if (selected) matches.set(canonicalHuddleJson(target), target);
      }
    }
    if (matches.size > 1) throw new Error('Recorded agent identity is ambiguous');
    return [...matches.values()][0] ?? null;
  }

  private verify(
    operation: ReturnType<HuddleSpawnMailbox['describe']>,
    result: HuddleSpawnOutcome,
  ) {
    if (
      result.agent.projectId !== operation.request.projectId ||
      result.agent.worktree !== operation.request.worktree ||
      result.receipt !== huddleSpawnReceipt(operation.scope, operation.request, result.agent)
    )
      throw new Error('Spawn readiness differs from its retained request');
  }
}
