import { z } from 'zod';
import { isoTimestamp } from '../common.js';
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
/** Retained observations cannot request external readout reconciliation. */
export const huddleRetainedHistoryRequestSchema = z.discriminatedUnion('collection', [
  huddleHistoryRequestSchema.options[0].omit({ include_readout_observation: true }),
  huddleHistoryRequestSchema.options[1].omit({ include_readout_observation: true }),
  huddleHistoryRequestSchema.options[2].omit({ include_readout_observation: true }),
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
