import { z } from 'zod';
import { sessionId } from '../../../api/common.js';
import { huddleKeySchema } from '../../../api/huddle/values.js';
import { huddleRevisionSchema } from '../../../api/huddle/events.js';
import { runtimeIdentitySchema } from '../../protocol.js';
import { runtimeNativeTurnCursorSchema } from '../../native-turns.js';

export const HUDDLE_COMPLETION_SOURCE_LIMIT = 8;
export const huddleCompletionSettingsSchema = z.strictObject({
  worktree: z.string().min(1).max(4096),
  session: sessionId,
});

/** The selected placement can differ from the owner's initial launch placement. */
export const huddleCompletionTargetSchema = z.strictObject({
  identity: runtimeIdentitySchema.strict(),
  sessionId,
  segmentId: z.uuid(),
  nativeRef: z.string().min(1).max(200),
});
export const huddleCompletionBaselineSchema = z.strictObject({
  node: huddleKeySchema,
  target: huddleCompletionTargetSchema,
  cursor: runtimeNativeTurnCursorSchema,
});
export const huddleCompletionBaselinesSchema = z
  .array(huddleCompletionBaselineSchema)
  .max(HUDDLE_COMPLETION_SOURCE_LIMIT)
  .refine((items) => new Set(items.map((item) => item.node)).size === items.length, {
    message: 'Duplicate completion baseline node',
  });
export const huddleCompletionSourceSchema = huddleCompletionBaselineSchema.extend({
  slot: z
    .number()
    .int()
    .min(0)
    .max(HUDDLE_COMPLETION_SOURCE_LIMIT - 1),
  activationId: z.uuid(),
  revision: huddleRevisionSchema,
  generation: z.number().int().nonnegative().safe(),
});
export type HuddleCompletionTarget = z.infer<typeof huddleCompletionTargetSchema>;
export type HuddleCompletionBaseline = z.infer<typeof huddleCompletionBaselineSchema>;
export type HuddleCompletionSource = z.infer<typeof huddleCompletionSourceSchema>;

/** Resolved resources for the inspected activation, without arming or rebasing a source. */
export const huddleCompletionPlanSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid(),
  revision: huddleRevisionSchema,
  sources: z
    .array(huddleCompletionSettingsSchema.extend({ node: huddleKeySchema }))
    .max(HUDDLE_COMPLETION_SOURCE_LIMIT)
    .refine((sources) => new Set(sources.map((source) => source.node)).size === sources.length),
});
export type HuddleCompletionPlan = z.infer<typeof huddleCompletionPlanSchema>;
