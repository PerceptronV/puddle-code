import { randomUUID } from 'node:crypto';
import {
  calendarHuddleTrigger,
  calendarDateHuddleTrigger,
  dateHuddleTrigger,
  huddleScheduleStateSchema,
  canonicalHuddleJson,
  type HuddleDefinition,
  type HuddleRevisionActivation,
  type HuddleScheduleRecord,
} from '@puddle/shared';
import { HuddleStateDatabase } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import type { scheduleDefinitions } from '../triggers/calendar/definitions.js';
import {
  dueScheduleOccurrences,
  type ScheduleOccurrence,
} from '../triggers/calendar/occurrences.js';

interface SchedulePlan {
  generation: number;
  activationId: string;
  schedule: HuddleScheduleRecord;
  occurrences: ScheduleOccurrence[];
}

/** Calendar/date progress is committed with admission, never with timer notification. */
export class HuddleSchedules {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}
  current() {
    const row = this.db.get('schedules', 'current');
    return row ? huddleScheduleStateSchema.parse(JSON.parse(row.body)) : null;
  }
  synchronise(
    activation: HuddleRevisionActivation,
    definitions: ReturnType<typeof scheduleDefinitions>,
    now: number,
  ) {
    return this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for schedule admission');
      const existing = this.current();
      if (existing?.activationId === activation.id && existing.generation === control.generation)
        return existing;
      const state = huddleScheduleStateSchema.parse({
        activationId: activation.id,
        generation: control.generation,
        schedules: definitions.map((definition) => {
          const previous =
            existing?.activationId === activation.id
              ? existing.schedules.find((item) => item.node === definition.node)
              : undefined;
          if (definition.kind !== 'date')
            return {
              ...definition,
              // Pause excludes new missed occurrences, but a clock rollback never replays old ones.
              through: Math.max(now, previous && previous.kind !== 'date' ? previous.through : 0),
            };
          return {
            ...definition,
            disposition:
              previous?.kind === 'date' && previous.disposition !== 'pending'
                ? previous.disposition
                : definition.due < now && definition.past === 'skip'
                  ? 'skipped'
                  : 'pending',
          };
        }),
      });
      this.db.put('schedules', 'current', activation.id, 'current', state, { bytes: 4096 });
      return state;
    });
  }
  plan(now: number, nodes?: ReadonlySet<string>): SchedulePlan[] {
    const state = this.current();
    return state
      ? state.schedules
          .filter((schedule) => !nodes || nodes.has(schedule.node))
          .map((schedule) => ({
            generation: state.generation,
            activationId: state.activationId,
            schedule,
            occurrences: dueScheduleOccurrences(schedule, now),
          }))
      : [];
  }
  admit(plan: SchedulePlan, limits: HuddleDefinition['execution'], now: number) {
    const occurrence = plan.occurrences[0];
    if (!occurrence) return null;
    const result = this.db.atomic(() => {
      const state = this.current(),
        control = this.activations.current();
      if (
        !state ||
        control.state !== 'armed' ||
        control.generation !== plan.generation ||
        state.generation !== plan.generation ||
        control.activationId !== plan.activationId ||
        state.activationId !== plan.activationId
      )
        throw new Error('Huddle schedule activation changed');
      const schedule = state.schedules.find((item) => item.node === plan.schedule.node);
      if (!schedule || canonicalHuddleJson(schedule) !== canonicalHuddleJson(plan.schedule))
        throw new Error('Huddle schedule progress changed');
      const activation = this.activations.get(state.activationId);
      const component =
        schedule.kind === 'calendar'
          ? calendarHuddleTrigger
          : schedule.kind === 'calendar-date'
            ? calendarDateHuddleTrigger
            : dateHuddleTrigger;
      const event = {
        format: 1 as const,
        // Generation is deliberately absent: the same instant cannot re-fire after Resume.
        id: `${activation.id}:${occurrence.at}`,
        source: { node: schedule.node, component: component.id, version: component.version },
        port: 'event',
        observedAt: new Date(now).toISOString(),
        occurredAt: occurrence.data.scheduledAt,
        scope: this.db.identity,
        revision: activation.revision,
        executionId: randomUUID(),
        data: occurrence.data,
      };
      const accepted = this.executions.accept(
        event,
        this.executions.cursor(this.executions.sourceKey(event)),
        { activationId: activation.id, at: occurrence.at },
        limits,
        now,
        activation.id,
      );
      if (schedule.kind !== 'date') schedule.through = occurrence.at;
      else schedule.disposition = 'admitted';
      this.db.put('schedules', 'current', activation.id, 'current', state, { bytes: 4096 });
      return { accepted, schedule };
    });
    // Mutate the temporary plan only after the durable transaction succeeds.
    plan.schedule = result.schedule;
    plan.occurrences.shift();
    return result.accepted;
  }
}
