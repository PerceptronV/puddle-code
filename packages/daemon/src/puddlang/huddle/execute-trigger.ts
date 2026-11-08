import {
  huddleTriggerCursorSchema,
  huddleTriggerEmissionSchema,
  huddleTriggerHealthSchema,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleJson,
} from '@puddle/shared';
import type { HuddleTriggerAdapter, HuddleTriggerContext } from './context.js';
import { immutable, snapshot, validateParameters } from './values.js';

export async function openHuddleTrigger(
  adapter: HuddleTriggerAdapter,
  component: HuddleComponent,
  context: HuddleTriggerContext,
  cursor: HuddleJson,
) {
  context.signal.throwIfAborted();
  if (component.category !== 'trigger' || !component.trigger)
    throw new Error('HuddleTrigger requires a declared subscription policy');
  const parameters = snapshot(context.parameters);
  validateParameters(component, parameters);
  const subscription = await adapter.open(
    {
      ...context,
      parameters,
      bindings: Object.freeze({ ...context.bindings }),
      health: async (value) => {
        context.signal.throwIfAborted();
        await context.health(huddleTriggerHealthSchema.parse(value));
      },
      checkpoint: async (value) => {
        context.signal.throwIfAborted();
        await context.checkpoint(immutable(huddleTriggerCursorSchema.parse(value)));
      },
      emit: async (value) => {
        context.signal.throwIfAborted();
        const emission = huddleTriggerEmissionSchema.parse(value);
        huddleTriggerCursorSchema.parse(emission.nextCursor);
        const port = component.outputs[emission.port];
        if (!port || validateHuddleValue(port.schema, emission.data).length)
          throw new Error('Invalid trigger output port or value');
        return context.emit(emission);
      },
    },
    immutable(huddleTriggerCursorSchema.parse(cursor)),
  );
  if (!subscription || typeof subscription.close !== 'function')
    throw new Error('Trigger open must return an asynchronous close function');
  return subscription;
}
