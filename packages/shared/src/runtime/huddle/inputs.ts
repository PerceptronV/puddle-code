import { z } from 'zod';
import { huddleJsonSchema, huddleKeySchema } from '../../api/huddle/values.js';
import { huddleRevisionSchema } from '../../api/huddle/events.js';

/** One immutable delivery per execution/node/input, never a latest-value cache. */
export const huddleExecutionInputSchema = z.strictObject({
  executionId: z.uuid(),
  revision: huddleRevisionSchema,
  node: huddleKeySchema,
  port: huddleKeySchema,
  delivery: huddleRevisionSchema,
  value: huddleJsonSchema,
});
export type HuddleExecutionInput = z.infer<typeof huddleExecutionInputSchema>;
