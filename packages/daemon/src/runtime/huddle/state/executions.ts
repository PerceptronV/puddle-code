import { z } from 'zod';
import {
  canonicalHuddleJson,
  huddleDefinitionSchema,
  huddleEventSchema,
  huddleExecutionRecordSchema,
  huddleInboxRecordSchema,
  huddleJsonSchema,
  type HuddleDefinition,
  type HuddleEvent,
  type HuddleExecutionRecord,
  type HuddleJson,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HuddleStateDatabase, stateJson } from './database.js';

const cursorSchema = z.strictObject({ cursor: huddleJsonSchema });
const budgetSchema = z.strictObject({
  executions: z.number().int().nonnegative(),
  spawns: z.number().int().nonnegative(),
});

export class HuddleExecutions {
  constructor(private readonly db: HuddleStateDatabase) {}

  sourceKey(event: HuddleEvent): string {
    return digest(canonicalHuddleJson(event.source));
  }

  cursor(source: string): HuddleJson {
    const row = this.db.get('cursors', source);
    return row ? cursorSchema.parse(JSON.parse(row.body)).cursor : null;
  }

  accept(
    eventInput: HuddleEvent,
    previous: HuddleJson,
    next: HuddleJson,
    limitsInput: HuddleDefinition['execution'],
    now = Date.now(),
  ) {
    const event = huddleEventSchema.parse(eventInput);
    huddleJsonSchema.parse(previous);
    huddleJsonSchema.parse(next);
    const limits = huddleDefinitionSchema.shape.execution.parse(limitsInput);
    if (canonicalHuddleJson(event.scope) !== canonicalHuddleJson(this.db.identity))
      throw new Error('Huddle event scope does not match its owner');
    const source = this.sourceKey(event);
    const key = digest(canonicalHuddleJson({ source, id: event.id }));
    const fingerprint = (value: HuddleEvent, cursor: HuddleJson) =>
      canonicalHuddleJson(
        stateJson({
          source: value.source,
          id: value.id,
          port: value.port,
          occurredAt: value.occurredAt,
          resource: value.resource,
          causation: value.causation,
          data: value.data,
          nextCursor: cursor,
        }),
      );
    return this.db.atomic(() => {
      const existing = this.db.get('inbox', key);
      if (existing) {
        const record = huddleInboxRecordSchema.parse(JSON.parse(existing.body));
        if (fingerprint(record.event, record.nextCursor) !== fingerprint(event, next))
          throw new Error('Trigger event id conflicts with retained work');
        return {
          sequence: existing.ordinal,
          duplicate: true,
          execution: this.get(record.event.executionId),
        };
      }
      if (canonicalHuddleJson(this.cursor(source)) !== canonicalHuddleJson(previous))
        throw new Error('Trigger cursor changed before admission');
      if (this.db.get('executions', event.executionId))
        throw new Error('Execution id is already in use');
      if (this.db.count('executions', { state: 'pending' }) >= limits.maxQueuedEvents)
        throw new Error('Huddle event queue is full');
      const day = new Date(now).toISOString().slice(0, 10);
      const budget = this.budget(day);
      if (budget.executions >= limits.maxDailyExecutions)
        throw new Error('Huddle daily execution limit reached');
      const record = huddleInboxRecordSchema.parse({ event, nextCursor: next, state: 'pending' });
      const execution = huddleExecutionRecordSchema.parse({
        id: event.executionId,
        eventKey: key,
        revision: event.revision,
        state: 'pending',
        limits,
        acceptedAt: now,
        deadline: now + limits.timeoutMs,
        turns: 0,
        spawns: 0,
        invocations: 0,
      });
      this.db.put('inbox', key, source, record.state, record);
      this.save(execution);
      this.db.put('cursors', source, '', 'current', { cursor: next });
      this.db.put('budgets', day, '', 'current', { ...budget, executions: budget.executions + 1 });
      return { sequence: this.db.get('inbox', key)!.ordinal, duplicate: false, execution };
    });
  }

  get(id: string): HuddleExecutionRecord {
    const row = this.db.get('executions', id);
    if (!row) throw new Error('Huddle execution does not exist');
    return huddleExecutionRecordSchema.parse(JSON.parse(row.body));
  }

  start(id: string, now = Date.now()): HuddleExecutionRecord {
    return this.db.atomic(() => {
      const execution = this.get(id);
      if (execution.state !== 'pending') throw new Error('Execution cannot be started again');
      if (now >= execution.deadline) throw new Error('Huddle execution deadline exceeded');
      if (this.db.count('executions', { state: 'running' }) >= execution.limits.concurrency)
        throw new Error('Huddle execution concurrency limit reached');
      execution.state = 'running';
      this.save(execution);
      const inbox = huddleInboxRecordSchema.parse(
        JSON.parse(this.db.get('inbox', execution.eventKey)!.body),
      );
      this.db.put('inbox', execution.eventKey, this.sourceKey(inbox.event), 'accepted', {
        ...inbox,
        state: 'accepted',
      });
      return execution;
    });
  }

  requireRunning(id: string, now = Date.now()): HuddleExecutionRecord {
    const record = this.get(id);
    if (record.state !== 'running') throw new Error('Huddle execution is not running');
    if (now >= record.deadline) throw new Error('Huddle execution deadline exceeded');
    return record;
  }

  /** Called in the same transaction as invocation/operation intent. */
  spend(id: string, kind: 'invocations' | 'turns' | 'spawns', now = Date.now()): void {
    const record = this.requireRunning(id, now);
    const limit =
      kind === 'turns'
        ? record.limits.maxTurns
        : kind === 'spawns'
          ? record.limits.maxAgents
          : record.limits.maxInvocations;
    if (record[kind] >= limit) throw new Error(`Huddle ${kind} limit reached`);
    if (kind === 'spawns') {
      const day = new Date(now).toISOString().slice(0, 10);
      const budget = this.budget(day);
      if (budget.spawns >= record.limits.maxDailyAgentSpawns)
        throw new Error('Huddle daily spawn limit reached');
      this.db.put('budgets', day, '', 'current', { ...budget, spawns: budget.spawns + 1 });
    }
    record[kind]++;
    this.save(record);
  }

  finish(
    id: string,
    state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
    error?: string,
  ): HuddleExecutionRecord {
    return this.db.atomic(() => {
      const record = this.get(id);
      if (!['pending', 'running'].includes(record.state)) {
        if (record.state === state && record.error === error) return record;
        throw new Error('Huddle execution already has a different terminal outcome');
      }
      if (state === 'completed' && record.state !== 'running')
        throw new Error('An unstarted execution cannot complete');
      if (
        state === 'completed' &&
        (this.db.count('invocations', { parent: id, state: 'running' }) ||
          this.db.count('invocations', { parent: id, state: 'pending' }) ||
          this.db.count('emissions', { parent: id, state: 'pending' }))
      )
        throw new Error('Huddle execution still has pending work');
      if (
        state === 'completed' &&
        ['prepared', 'dispatched', 'unknown'].some((state) =>
          this.db.count('operations', { parent: id, state }),
        )
      )
        throw new Error('Huddle execution still has unresolved operations');
      const inboxRow = this.db.get('inbox', record.eventKey)!;
      const inbox = huddleInboxRecordSchema.parse(JSON.parse(inboxRow.body));
      if (inbox.state === 'pending' && state !== 'completed')
        this.db.put('inbox', record.eventKey, inboxRow.parent, 'cancelled', {
          ...inbox,
          state: 'cancelled',
        });
      return this.save({ ...record, state, ...(error === undefined ? {} : { error }) });
    });
  }

  private budget(day: string) {
    const row = this.db.get('budgets', day);
    return row ? budgetSchema.parse(JSON.parse(row.body)) : { executions: 0, spawns: 0 };
  }

  private save(record: HuddleExecutionRecord): HuddleExecutionRecord {
    const parsed = huddleExecutionRecordSchema.parse(record);
    this.db.put('executions', record.id, record.revision, record.state, parsed);
    return parsed;
  }
}
