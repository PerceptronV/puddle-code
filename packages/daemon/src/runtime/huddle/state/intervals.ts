import { randomUUID } from 'node:crypto';
import {
  huddleIntervalStateSchema,
  intervalHuddleTrigger,
  nextHuddleInterval,
  type HuddleDefinition,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import { HuddleStateDatabase } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import type { intervalDefinitions } from '../triggers/definitions.js';

/** Timer progress and event admission commit together in the owner ledger. */
export class HuddleIntervals {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}

  current() {
    const row = this.db.get('intervals', 'current');
    return row ? huddleIntervalStateSchema.parse(JSON.parse(row.body)) : null;
  }
  synchronise(
    activation: HuddleRevisionActivation,
    schedules: ReturnType<typeof intervalDefinitions>,
    now: number,
  ) {
    return this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for timer admission');
      const existing = this.current();
      if (existing?.generation === control.generation && existing.activationId === activation.id)
        return existing;
      const state = huddleIntervalStateSchema.parse({
        generation: control.generation,
        activationId: activation.id,
        schedules: schedules.map((schedule) => ({ ...schedule, anchor: now, last: 0 })),
      });
      this.db.put('intervals', 'current', activation.id, 'current', state, { bytes: 4096 });
      return state;
    });
  }
  admit(node: string, limits: HuddleDefinition['execution'], now: number) {
    return this.db.atomic(() => {
      const state = this.current(),
        control = this.activations.current();
      if (
        !state ||
        control.state !== 'armed' ||
        state.generation !== control.generation ||
        state.activationId !== control.activationId
      )
        throw new Error('Huddle timer activation changed');
      const schedule = state.schedules.find((schedule) => schedule.node === node);
      if (!schedule) throw new Error('Huddle timer no longer exists');
      const next = nextHuddleInterval(schedule, now);
      if (!next) return null;
      const activation = this.activations.get(state.activationId);
      const { ordinal, ...data } = next;
      const event = {
        format: 1 as const,
        id: `${activation.id}:${state.generation}:${ordinal}`,
        source: { node, component: intervalHuddleTrigger.id, version: 1 },
        port: 'event',
        observedAt: new Date(now).toISOString(),
        occurredAt: next.scheduledAt,
        scope: this.db.identity,
        revision: activation.revision,
        executionId: randomUUID(),
        data,
      };
      const result = this.executions.accept(
        event,
        this.executions.cursor(this.executions.sourceKey(event)),
        { generation: state.generation, ordinal },
        limits,
        now,
        activation.id,
      );
      schedule.last = ordinal;
      this.db.put('intervals', 'current', activation.id, 'current', state, { bytes: 4096 });
      return result;
    });
  }
}
