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
import { HuddleExecutionInputs } from './inputs.js';

export class HuddleJoins {
  private readonly inputs: HuddleExecutionInputs;
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly invocations: HuddleInvocations,
  ) {
    this.inputs = new HuddleExecutionInputs(db);
  }

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
    if (component.inputs[port]?.scope === 'execution') {
      if (
        !this.inputs.set({
          executionId: context.executionId,
          revision: context.revision,
          node: context.node,
          port,
          value,
          delivery,
        })
      )
        return;
      // A retained input never starts a cohort. It only satisfies already waiting cohorts.
      let after = 0;
      for (;;) {
        const rows = this.db.list('joins', {
          parent: context.executionId,
          state: 'waiting',
          after,
        });
        if (!rows.length) break;
        for (const row of rows) {
          after = row.ordinal;
          const join = huddleJoinRecordSchema.parse(JSON.parse(row.body));
          if (join.node !== context.node) continue;
          if (join.revision !== context.revision) throw new Error('Join revision changed');
          this.admit(row.id, join, component, now);
        }
      }
      return;
    }
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
    this.admit(key, join, component, now);
  }

  private admit(key: string, join: HuddleJoinRecord, component: HuddleComponent, now: number) {
    for (const [name, contract] of Object.entries(component.inputs)) {
      if (contract.scope !== 'execution') continue;
      const retained = this.inputs.get({
        executionId: join.executionId,
        revision: join.revision,
        node: join.node,
        port: name,
      });
      if (!retained) continue;
      join.inputs[name] = retained.value;
      join.deliveries[name] = retained.delivery;
    }
    if (
      component.activation === 'any' ||
      Object.entries(component.inputs).every(
        ([name, contract]) => !contract.required || Object.hasOwn(join.inputs, name),
      )
    ) {
      const admitted = this.invocations.queue(
        {
          id: randomUUID(),
          executionId: join.executionId,
          revision: join.revision,
          node: join.node,
          activation: join.activation,
          iteration: join.iteration,
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
