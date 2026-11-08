import {
  HUDDLE_LIMITS,
  huddleOperationRecordSchema,
  canonicalHuddleJson,
  huddleJsonSchema,
  type HuddleJson,
  type HuddleOperationRecord,
} from '@puddle/shared';
import { HuddleStateDatabase, stateJson } from './database.js';
import { HuddleInvocations } from './invocations.js';
import { HuddleExecutions } from './executions.js';
import { HuddleSpawnCleanup } from './spawn-cleanup.js';

const OUTCOME_RESERVATION = HUDDLE_LIMITS.valueBytes + 8192;

export class HuddleOperations {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly invocations: HuddleInvocations,
  ) {}

  prepare(
    input: Pick<HuddleOperationRecord, 'id' | 'invocationId' | 'kind' | 'target' | 'input'>,
    now = Date.now(),
  ) {
    return this.db.atomic(() => {
      const invocation = this.invocations.get(input.invocationId);
      const operation = huddleOperationRecordSchema.parse({
        ...input,
        executionId: invocation.executionId,
        state: 'prepared',
        consumed: false,
      });
      const existing = this.db.get('operations', operation.id);
      if (existing) {
        const record = huddleOperationRecordSchema.parse(JSON.parse(existing.body));
        const intent = (value: HuddleOperationRecord) =>
          canonicalHuddleJson(
            stateJson({
              ...value,
              state: undefined,
              consumed: undefined,
              result: undefined,
              error: undefined,
            }),
          );
        if (intent(record) !== intent(operation))
          throw new Error('Operation id conflicts with retained intent');
        return { record, duplicate: true };
      }
      this.executions.requireRunning(invocation.executionId, now);
      if (invocation.state !== 'running')
        throw new Error('Operation requires a running node invocation');
      this.save(operation, OUTCOME_RESERVATION);
      if (operation.kind === 'spawn')
        new HuddleSpawnCleanup(this.db).prepare(operation.id, operation.executionId);
      return { record: operation, duplicate: false };
    });
  }

  /** Commit consumption BEFORE external dispatch. This method never grants a second send. */
  dispatch(id: string, now = Date.now()): HuddleOperationRecord {
    return this.db.atomic(() => {
      const record = this.get(id);
      const invocation = this.invocations.get(record.invocationId);
      this.executions.requireRunning(record.executionId, now);
      if (invocation.state !== 'running' || record.state !== 'prepared' || record.consumed)
        throw new Error('Operation dispatch is unavailable or already consumed');
      if (record.kind === 'ask') this.executions.spend(record.executionId, 'turns', now);
      if (record.kind === 'spawn') this.executions.spend(record.executionId, 'spawns', now);
      return this.save({ ...record, state: 'dispatched', consumed: true }, OUTCOME_RESERVATION);
    });
  }

  get(id: string): HuddleOperationRecord {
    const row = this.db.get('operations', id);
    if (!row) throw new Error('Huddle operation does not exist');
    return huddleOperationRecordSchema.parse(JSON.parse(row.body));
  }

  settle(id: string, state: 'completed' | 'failed', result: HuddleJson): HuddleOperationRecord {
    huddleJsonSchema.parse(result);
    return this.db.atomic(() => {
      const record = this.get(id);
      if (record.state === 'completed' || record.state === 'failed') {
        if (
          record.state !== state ||
          canonicalHuddleJson(record.result!) !== canonicalHuddleJson(result)
        )
          throw new Error('Operation outcome conflicts with retained result');
        return record;
      }
      if (!record.consumed || !['dispatched', 'unknown'].includes(record.state))
        throw new Error('Cannot settle an undispatched operation');
      const { error: _error, ...prior } = record;
      return this.save({ ...prior, state, result });
    });
  }

  unknown(id: string, error: string): HuddleOperationRecord {
    return this.db.atomic(() => {
      const record = this.get(id);
      if (!record.consumed || !['dispatched', 'unknown'].includes(record.state))
        throw new Error('Only an attempted operation can have an unknown outcome');
      return this.save({ ...record, state: 'unknown', error }, OUTCOME_RESERVATION);
    });
  }

  cancelUnsent(id: string): HuddleOperationRecord {
    return this.db.atomic(() => {
      const record = this.get(id);
      if (record.consumed || !['prepared', 'cancelled'].includes(record.state))
        throw new Error('An attempted operation requires reconciliation');
      return this.save({ ...record, state: 'cancelled' });
    });
  }

  private save(value: HuddleOperationRecord, reserved = 0): HuddleOperationRecord {
    const record = huddleOperationRecordSchema.parse(value);
    this.db.put('operations', record.id, record.executionId, record.state, record, {
      bytes: reserved,
      subject: record.invocationId,
    });
    return record;
  }
}
