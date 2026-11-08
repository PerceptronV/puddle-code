import { z } from 'zod';
import { huddleRevisionSchema } from '../../api/huddle/events.js';
import { huddleJsonSchema, huddleKeySchema, HUDDLE_LIMITS } from '../../api/huddle/values.js';

/** Inputs only join within one execution and one causal activation/iteration. */
export const huddleJoinRecordSchema = z
  .strictObject({
    executionId: z.uuid(),
    revision: huddleRevisionSchema,
    node: huddleKeySchema,
    activation: huddleRevisionSchema,
    iteration: z.number().int().min(0).max(1000),
    state: z.enum(['waiting', 'queued', 'cancelled']),
    inputs: z
      .record(huddleKeySchema, huddleJsonSchema)
      .refine(
        (value) =>
          Object.keys(value).length <= HUDDLE_LIMITS.ports &&
          huddleJsonSchema.safeParse(value).success,
      ),
    deliveries: z
      .record(huddleKeySchema, huddleRevisionSchema)
      .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports),
    invocationId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.state === 'queued') !== (value.invocationId !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only admitted joins have an invocation' });
  });
export type HuddleJoinRecord = z.infer<typeof huddleJoinRecordSchema>;
