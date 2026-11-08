import { z } from 'zod';
import { isoTimestamp } from '../common.js';
import { huddleCommandTargetSchema } from './execution.js';
import { huddleComponentIdSchema } from './components.js';
import { huddleKeySchema, HUDDLE_LIMITS } from './values.js';

const count = z.number().int().nonnegative().safe();
export const huddleTriggerActivitySchema = z.strictObject({
  node: huddleKeySchema,
  admitted: count,
  queued: count,
  running: count,
  last_event_at: isoTimestamp.nullable(),
  coalesced: count,
  skipped: count,
});
export const huddleTriggerReportSchema = z.strictObject({
  target: huddleCommandTargetSchema,
  observed_at: isoTimestamp,
  lifecycle: z.enum(['armed', 'interrupted', 'stopped']),
  backlog: z.strictObject({ queued: count, running: count, uncertain_operations: count }),
  queue_limit: count.nullable(),
  sources: z
    .array(
      huddleTriggerActivitySchema.extend({
        component: huddleComponentIdSchema,
        health: z.enum([
          'ready',
          'starting',
          'inactive',
          'complete',
          'blocked',
          'gap',
          'degraded',
          'closed',
        ]),
        message: z.string().max(4096).optional(),
        next_at: isoTimestamp.nullable(),
        missed: z.enum(['coalesce', 'skip', 'catch-up', 'fire']).optional(),
        disposition: z.enum(['pending', 'admitted', 'skipped']).optional(),
      }),
    )
    .max(HUDDLE_LIMITS.nodes),
});
export type HuddleTriggerReport = z.infer<typeof huddleTriggerReportSchema>;
export type HuddleTriggerActivity = z.infer<typeof huddleTriggerActivitySchema>;
export function parseHuddleTriggerReport(
  target: z.infer<typeof huddleCommandTargetSchema>,
  value: unknown,
) {
  const report = huddleTriggerReportSchema.parse(value);
  if (
    report.target.runtimeId !== target.runtimeId ||
    report.target.incarnation !== target.incarnation ||
    report.target.generation !== target.generation ||
    report.target.activationId !== target.activationId
  )
    throw new Error('Trigger inspection refers to a different huddle activation');
  return report;
}
