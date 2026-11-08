import { randomUUID } from 'node:crypto';
import {
  canonicalHuddleJson,
  huddleJoinRecordSchema,
  type HuddleComponent,
  type HuddleJoinRecord,
  type HuddleJson,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HuddleStateDatabase } from './database.js';
import { HuddleInvocations } from './invocations.js';

export class HuddleJoins {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly invocations: HuddleInvocations,
  ) {}

  /** Caller holds the emission/trigger transaction; acknowledgement includes this write. */
  deliver(
    context: Pick<
      HuddleJoinRecord,
      'executionId' | 'revision' | 'node' | 'activation' | 'iteration'
    >,
    port: string,
    value: HuddleJson,
    delivery: string,
    component: HuddleComponent,
    now: number,
  ): void {
    const key = digest(
      canonicalHuddleJson({
        execution: context.executionId,
        node: context.node,
        activation: context.activation,
      }),
    );
    const row = this.db.get('joins', key);
    const join = row
      ? huddleJoinRecordSchema.parse(JSON.parse(row.body))
      : huddleJoinRecordSchema.parse({
          ...context,
          state: 'waiting',
          inputs: {},
          deliveries: {},
        });
    if (join.revision !== context.revision || join.iteration !== context.iteration)
      throw new Error('Join causal identity changed');
    if (join.state === 'cancelled') throw new Error('Join was cancelled');
    if (Object.hasOwn(join.deliveries, port)) {
      if (
        join.deliveries[port] !== delivery ||
        canonicalHuddleJson(join.inputs[port]!) !== canonicalHuddleJson(value)
      )
        throw new Error('Two deliveries compete for the same join input');
      return;
    }
    // Optional values arriving after admission cannot modify an immutable invocation.
    if (join.state === 'queued') {
      if (component.inputs[port]?.required)
        throw new Error('Required input arrived after join admission');
      return;
    }
    join.inputs[port] = value;
    join.deliveries[port] = delivery;
    if (
      component.activation === 'any' ||
      Object.entries(component.inputs).every(
        ([name, contract]) => !contract.required || Object.hasOwn(join.inputs, name),
      )
    ) {
      const admitted = this.invocations.queue(
        {
          id: randomUUID(),
          ...context,
          inputs: join.inputs,
        },
        now,
      );
      join.state = 'queued';
      join.invocationId = admitted.record.id;
    }
    const record = huddleJoinRecordSchema.parse(join);
    this.db.put('joins', key, record.executionId, record.state, record, {
      bytes: record.state === 'waiting' ? 32 : 0,
    });
  }
}
