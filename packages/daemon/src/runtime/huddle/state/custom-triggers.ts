import { randomUUID } from 'node:crypto';
import {
  HUDDLE_CUSTOM_TRIGGER_LIMIT,
  canonicalHuddleJson,
  huddleCustomTriggerSourceSchema,
  huddleTriggerEmissionSchema,
  huddleTriggerHealthSchema,
  huddleTriggerCursorSchema,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleCustomTriggerSource,
  type HuddleDefinition,
  type HuddleJson,
  type HuddleRevisionActivation,
  type HuddleTriggerHealth,
  type HuddleTriggerEmission,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HuddleStateDatabase } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import type { customTriggerDefinitions } from '../triggers/custom/definitions.js';

/** Bounded subscription slots. Cursor and root admission share the same transaction. */
export class HuddleCustomTriggers {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}
  list() {
    const records: HuddleCustomTriggerSource[] = [];
    for (let slot = 0; slot < HUDDLE_CUSTOM_TRIGGER_LIMIT; slot++) {
      const row = this.db.get('custom-sources', String(slot));
      if (row) records.push(huddleCustomTriggerSourceSchema.parse(JSON.parse(row.body)));
    }
    return records;
  }
  synchronise(
    activation: HuddleRevisionActivation,
    definitions: ReturnType<typeof customTriggerDefinitions>,
  ) {
    return this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for custom subscriptions');
      const retained = this.list();
      for (const old of retained) this.save({ ...old, health: { state: 'closed' } });
      return definitions.map((definition) => {
        const old = retained.find(
          (source) =>
            source.node === definition.node &&
            source.activationId === activation.id &&
            source.revision === activation.revision,
        );
        const continuing =
          old && (old.generation === control.generation || definition.resume === 'continue');
        const { resume: _resume, ...identity } = definition;
        const source = huddleCustomTriggerSourceSchema.parse({
          ...identity,
          id: continuing ? old.id : randomUUID(),
          activationId: activation.id,
          generation: control.generation,
          revision: activation.revision,
          cursor: continuing ? old.cursor : null,
          health: { state: 'degraded', message: 'Opening subscription' },
        });
        return this.save(source);
      });
    });
  }
  requireCurrent(source: HuddleCustomTriggerSource) {
    const row = this.db.get('custom-sources', String(source.slot));
    const current = row ? huddleCustomTriggerSourceSchema.parse(JSON.parse(row.body)) : null;
    const control = this.activations.current();
    if (
      !current ||
      current.id !== source.id ||
      current.node !== source.node ||
      current.revision !== source.revision ||
      current.activationId !== source.activationId ||
      current.generation !== source.generation ||
      control.state !== 'armed' ||
      control.activationId !== source.activationId ||
      control.generation !== source.generation
    )
      throw new Error('Custom trigger subscription is no longer current');
    return current;
  }
  health(source: HuddleCustomTriggerSource, health: HuddleTriggerHealth) {
    return this.db.atomic(() => {
      const current = this.requireCurrent(source);
      if (current.health.state === 'gap' || current.health.state === 'closed')
        throw new Error('Custom trigger health is terminal until explicit rearm');
      return this.save({ ...current, health: huddleTriggerHealthSchema.parse(health) });
    });
  }
  close(source: HuddleCustomTriggerSource) {
    return this.db.atomic(() => {
      const row = this.db.get('custom-sources', String(source.slot));
      if (!row) return;
      const current = huddleCustomTriggerSourceSchema.parse(JSON.parse(row.body));
      if (
        current.id === source.id &&
        current.generation === source.generation &&
        current.health.state !== 'gap'
      )
        this.save({ ...current, health: { state: 'closed' } });
    });
  }
  checkpoint(source: HuddleCustomTriggerSource, value: HuddleJson) {
    const cursor = huddleTriggerCursorSchema.parse(value);
    return this.db.atomic(() => {
      const current = this.requireCurrent(source);
      if (current.health.state === 'gap' || current.health.state === 'closed')
        throw new Error('Custom trigger cannot checkpoint after a gap or close');
      return this.save({ ...current, cursor });
    });
  }
  admit(
    source: HuddleCustomTriggerSource,
    input: HuddleTriggerEmission,
    component: HuddleComponent,
    limits: HuddleDefinition['execution'],
    now = Date.now(),
  ) {
    const emission = huddleTriggerEmissionSchema.parse(input);
    huddleTriggerCursorSchema.parse(emission.nextCursor);
    const port = component.outputs[emission.port];
    if (
      component.id !== source.component ||
      component.version !== source.version ||
      component.category !== 'trigger' ||
      !port ||
      validateHuddleValue(port.schema, emission.data).length
    )
      throw new Error('Custom trigger emitted an invalid captured output');
    return this.db.atomic(() => {
      const current = this.requireCurrent(source);
      if (current.health.state === 'gap' || current.health.state === 'closed')
        throw new Error('Custom trigger cannot admit events after a gap or close');
      const worktree = this.activations.get(source.activationId).bindings[source.node]?.worktree;
      const event = {
        format: 1 as const,
        id: digest(canonicalHuddleJson({ subscription: source.id, event: emission.id })),
        source: { node: source.node, component: source.component, version: source.version },
        port: emission.port,
        observedAt: new Date(now).toISOString(),
        ...(emission.occurredAt ? { occurredAt: emission.occurredAt } : {}),
        scope: this.db.identity,
        revision: source.revision,
        executionId: randomUUID(),
        data: emission.data,
        ...(worktree ? { resource: { kind: 'worktree' as const, worktree } } : {}),
      };
      const result = this.executions.accept(
        event,
        this.executions.cursor(this.executions.sourceKey(event)),
        { subscription: source.id, cursor: emission.nextCursor },
        limits,
        now,
        source.activationId,
      );
      if (!result.duplicate) this.save({ ...current, cursor: emission.nextCursor });
      return { sequence: result.sequence, duplicate: result.duplicate };
    });
  }
  private save(source: HuddleCustomTriggerSource) {
    const parsed = huddleCustomTriggerSourceSchema.parse(source);
    this.db.put(
      'custom-sources',
      String(parsed.slot),
      parsed.activationId,
      parsed.health.state,
      parsed,
      { bytes: 128 * 1024 },
    );
    return parsed;
  }
}
