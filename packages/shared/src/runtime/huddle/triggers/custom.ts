import { z } from 'zod';
import { huddleKeySchema, huddleJsonSchema } from '../../../api/huddle/values.js';
import { huddleRevisionSchema, huddleTriggerHealthSchema } from '../../../api/huddle/events.js';
import { huddleComponentIdSchema } from '../../../api/huddle/components.js';

export const HUDDLE_CUSTOM_TRIGGER_LIMIT = 8;
export const huddleTriggerCursorSchema = huddleJsonSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024,
  'Trigger cursor exceeds 64 KiB',
);
export const huddleCustomTriggerSourceSchema = z.strictObject({
  slot: z
    .number()
    .int()
    .min(0)
    .max(HUDDLE_CUSTOM_TRIGGER_LIMIT - 1),
  id: z.uuid(),
  activationId: z.uuid(),
  generation: z.number().int().nonnegative().safe(),
  revision: huddleRevisionSchema,
  node: huddleKeySchema,
  component: huddleComponentIdSchema,
  version: z.number().int().positive(),
  cursor: huddleTriggerCursorSchema,
  health: huddleTriggerHealthSchema,
});
export type HuddleCustomTriggerSource = z.infer<typeof huddleCustomTriggerSourceSchema>;
export const huddleCustomTriggerViewSchema = huddleCustomTriggerSourceSchema
  .pick({
    node: true,
    health: true,
  })
  .extend({
    health: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('ready') }),
      z.strictObject({ state: z.literal('closed') }),
      z.strictObject({ state: z.literal('degraded'), message: z.string().min(1).max(4096) }),
      z.strictObject({ state: z.literal('gap'), message: z.string().min(1).max(4096) }),
    ]),
  });
