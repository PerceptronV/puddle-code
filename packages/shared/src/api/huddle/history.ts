import { z } from 'zod';
import { isoTimestamp } from '../common.js';
import { huddleEventSchema } from './events.js';
import {
  huddleHistoryPageSchema,
  huddleHistoryRequestSchema,
  huddleRuntimeTargetSchema,
} from './execution.js';

export const huddleHistoryCursorSchema = z.strictObject({
  created_at: isoTimestamp,
  runtime_id: z.uuid(),
});
export const huddleHistoryOwnersRequestSchema = z.strictObject({
  after: huddleHistoryCursorSchema.optional(),
});
export const huddleHistoryOwnersSchema = z.strictObject({
  source: z.literal('recorded-bindings'),
  records: z
    .array(
      z.strictObject({
        owner: huddleRuntimeTargetSchema,
        build: z.string().max(128),
        recorded_state: z.enum(['prepared', 'running', 'exited', 'failed', 'interrupted']),
        created_at: isoTimestamp,
        ended_at: isoTimestamp.nullable(),
      }),
    )
    .max(64),
  next: huddleHistoryCursorSchema.nullable(),
});
/** Reading retained history may offer observation, but never executes an adapter. */
export const huddleRetainedHistoryRequestSchema = z.discriminatedUnion('collection', [
  huddleHistoryRequestSchema.options[0],
  huddleHistoryRequestSchema.options[1],
  huddleHistoryRequestSchema.options[2],
]);
export const huddleRetainedHistorySchema = z.strictObject({
  source: z.literal('retained-ledger'),
  observed_at: isoTimestamp,
  history: huddleHistoryPageSchema,
});
export type HuddleHistoryOwnersRequest = z.infer<typeof huddleHistoryOwnersRequestSchema>;
export type HuddleHistoryOwners = z.infer<typeof huddleHistoryOwnersSchema>;
export type HuddleRetainedHistoryRequest = z.infer<typeof huddleRetainedHistoryRequestSchema>;
export type HuddleRetainedHistory = z.infer<typeof huddleRetainedHistorySchema>;

export const huddleTriggerInputRequestSchema = z.strictObject({
  owner: huddleRuntimeTargetSchema,
  execution_id: z.uuid(),
});
export const huddleTriggerInputSchema = z.strictObject({
  source: z.literal('retained-trigger'),
  observed_at: isoTimestamp,
  owner: huddleRuntimeTargetSchema,
  event: huddleEventSchema.pick({
    id: true,
    source: true,
    port: true,
    observedAt: true,
    occurredAt: true,
    revision: true,
    executionId: true,
    data: true,
  }),
});
export type HuddleTriggerInputRequest = z.infer<typeof huddleTriggerInputRequestSchema>;
export type HuddleTriggerInput = z.infer<typeof huddleTriggerInputSchema>;
export function parseHuddleTriggerInput(request: HuddleTriggerInputRequest, value: unknown) {
  const result = huddleTriggerInputSchema.parse(value);
  if (
    result.owner.runtimeId !== request.owner.runtimeId ||
    result.owner.incarnation !== request.owner.incarnation ||
    result.event.executionId !== request.execution_id
  )
    throw new Error('Recorded trigger input differs from the requested execution');
  return result;
}

export const huddleRetainedReadoutObserveSchema = z.strictObject({
  owner: huddleRuntimeTargetSchema,
  operation_id: z.uuid(),
});
export type HuddleRetainedReadoutObserve = z.infer<typeof huddleRetainedReadoutObserveSchema>;
