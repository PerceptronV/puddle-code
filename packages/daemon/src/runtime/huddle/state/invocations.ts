import { z } from 'zod';
import {
  canonicalHuddleJson,
  huddleEmissionRecordSchema,
  huddleInvocationRecordSchema,
  huddleJsonSchema,
  huddleKeySchema,
  HUDDLE_LIMITS,
  type HuddleInvocationRecord,
  type HuddleJson,
  type HuddleEmissionRecord,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HuddleStateDatabase, stateJson } from './database.js';
import { HuddleExecutions } from './executions.js';

const RESULT_RESERVATION = 2 * HUDDLE_LIMITS.valueBytes + HUDDLE_LIMITS.ports * 2048;
const activationSchema = z.strictObject({ id: z.uuid() });
const recordValues = z
  .record(huddleKeySchema, huddleJsonSchema)
  .refine(
    (values) =>
      Object.keys(values).length <= HUDDLE_LIMITS.ports &&
      huddleJsonSchema.safeParse(values).success,
  );

export class HuddleInvocations {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
  ) {}

  queue(
    input: Omit<HuddleInvocationRecord, 'state' | 'result' | 'error' | 'lastEmission'>,
    now = Date.now(),
  ) {
    const record = huddleInvocationRecordSchema.parse({
      ...input,
      state: 'pending',
      lastEmission: 0,
    });
    recordValues.parse(record.inputs);
    const activation = digest(
      canonicalHuddleJson({
        execution: record.executionId,
        node: record.node,
        activation: record.activation,
      }),
    );
    return this.db.atomic(() => {
      const existing = this.db.get('activations', activation);
      if (existing) {
        const original = this.get(activationSchema.parse(JSON.parse(existing.body)).id);
        const intent = (value: HuddleInvocationRecord) =>
          canonicalHuddleJson(
            stateJson({
              ...value,
              id: undefined,
              state: undefined,
              result: undefined,
              error: undefined,
              lastEmission: undefined,
            }),
          );
        if (intent(original) !== intent(record))
          throw new Error('Node activation conflicts with retained work');
        return { record: original, duplicate: true };
      }
      if (this.db.get('invocations', record.id)) throw new Error('Invocation id is already in use');
      const execution = this.executions.requireRunning(record.executionId, now);
      if (execution.revision !== record.revision)
        throw new Error('Node revision differs from its execution');
      this.executions.spend(record.executionId, 'invocations', now);
      this.save(record);
      this.db.put('activations', activation, record.executionId, 'retained', { id: record.id });
      return { record, duplicate: false };
    });
  }

  start(id: string, now = Date.now(), maxConcurrent = 1): HuddleInvocationRecord {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32)
      throw new Error('Invalid node concurrency limit');
    return this.db.atomic(() => {
      const record = this.get(id);
      this.executions.requireRunning(record.executionId, now);
      if (record.state !== 'pending') throw new Error('Node invocation cannot be started again');
      if (
        this.db.count('invocations', {
          subject: `${record.revision}:${record.node}`,
          state: 'running',
        }) >= maxConcurrent
      )
        throw new Error('Huddle node concurrency limit reached');
      return this.save({ ...record, state: 'running' }, RESULT_RESERVATION);
    });
  }

  get(id: string): HuddleInvocationRecord {
    const row = this.db.get('invocations', id);
    if (!row) throw new Error('Huddle invocation does not exist');
    return huddleInvocationRecordSchema.parse(JSON.parse(row.body));
  }

  emit(
    id: string,
    sequence: number,
    port: string,
    value: HuddleJson,
    now = Date.now(),
  ): { record: HuddleEmissionRecord; duplicate: boolean } {
    huddleJsonSchema.parse(value);
    return this.db.atomic(() => {
      const invocation = this.get(id);
      const record = huddleEmissionRecordSchema.parse({
        invocationId: id,
        executionId: invocation.executionId,
        revision: invocation.revision,
        node: invocation.node,
        sequence,
        port,
        value,
        kind: 'event',
        state: 'pending',
      });
      const key = `${id}:${sequence}`;
      const existing = this.db.get('emissions', key);
      if (existing) {
        const original = huddleEmissionRecordSchema.parse(JSON.parse(existing.body));
        if (
          canonicalHuddleJson(stateJson({ ...original, state: 'pending' })) !==
          canonicalHuddleJson(record)
        )
          throw new Error('Emission sequence conflicts with retained output');
        return { record: original, duplicate: true };
      }
      this.executions.requireRunning(invocation.executionId, now);
      if (invocation.state !== 'running') throw new Error('Cannot emit after node completion');
      // Require contiguous sequences; a lost acknowledgement is observation-only.
      if (sequence !== invocation.lastEmission + 1)
        throw new Error('Node emission sequence is not next');
      this.db.put('emissions', key, record.executionId, record.state, record);
      this.save(
        { ...invocation, lastEmission: sequence },
        this.db.get('invocations', id)!.reserved,
      );
      return { record, duplicate: false };
    });
  }

  complete(
    id: string,
    outputs: Record<string, HuddleJson>,
    now = Date.now(),
  ): HuddleInvocationRecord {
    recordValues.parse(outputs);
    return this.db.atomic(() => {
      const record = this.get(id);
      if (record.state === 'completed') {
        if (canonicalHuddleJson(record.result!) !== canonicalHuddleJson(outputs))
          throw new Error('Node completion conflicts with retained output');
        return record;
      }
      this.executions.requireRunning(record.executionId, now);
      if (record.state !== 'running') throw new Error('Only a running node can complete');
      for (const state of ['prepared', 'dispatched', 'unknown']) {
        if (this.db.count('operations', { subject: id, state }))
          throw new Error('Node still has unresolved operations');
      }
      const completed = this.save({
        ...record,
        state: 'completed',
        result: outputs,
        lastEmission: record.lastEmission + Object.keys(outputs).length,
      });
      let sequence = record.lastEmission;
      for (const [port, value] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
        const emission = huddleEmissionRecordSchema.parse({
          invocationId: id,
          executionId: record.executionId,
          revision: record.revision,
          node: record.node,
          sequence: ++sequence,
          port,
          value,
          kind: 'completion',
          state: 'pending',
        });
        this.db.put('emissions', `${id}:${sequence}`, record.executionId, 'pending', emission);
      }
      return completed;
    });
  }

  finish(
    id: string,
    state: 'failed' | 'cancelled' | 'interrupted',
    error: string,
  ): HuddleInvocationRecord {
    return this.db.atomic(() => {
      const record = this.get(id);
      if (!['pending', 'running'].includes(record.state)) {
        if (record.state === state && record.error === error) return record;
        throw new Error('Node invocation already has a different outcome');
      }
      return this.save({ ...record, state, error });
    });
  }

  /** A route consumer must enqueue its effects in this same transaction before acknowledging. */
  route(
    id: string,
    sequence: number,
    consume: (emission: HuddleEmissionRecord) => void,
    now = Date.now(),
  ): boolean {
    return this.db.atomic(() => {
      const key = `${id}:${sequence}`;
      const row = this.db.get('emissions', key);
      if (!row) throw new Error('Node emission does not exist');
      const emission = huddleEmissionRecordSchema.parse(JSON.parse(row.body));
      if (emission.state === 'routed') return false;
      if (emission.state !== 'pending') throw new Error('Emission was cancelled');
      this.executions.requireRunning(emission.executionId, now);
      const result: unknown = consume(emission);
      if (result !== null && typeof result === 'object' && 'then' in result)
        throw new Error('Route admission must be synchronous');
      this.db.put('emissions', key, emission.executionId, 'routed', {
        ...emission,
        state: 'routed',
      });
      return true;
    });
  }

  private save(record: HuddleInvocationRecord, reserved = 0): HuddleInvocationRecord {
    const value = huddleInvocationRecordSchema.parse(record);
    this.db.put('invocations', value.id, value.executionId, value.state, value, {
      bytes: reserved,
      records: reserved ? HUDDLE_LIMITS.ports : 0,
      subject: `${value.revision}:${value.node}`,
    });
    return value;
  }
}
