import { z } from 'zod';
import { huddleKeySchema } from '../../../api/huddle/values.js';

export const HUDDLE_INTERVAL_LIMIT = 32;
export const huddleIntervalSettingsSchema = z.strictObject({
  intervalMs: z.number().int().min(1000).max(86400000),
  missed: z.enum(['coalesce', 'skip', 'catch-up']),
  maxCatchUp: z.number().int().min(1).max(64),
});
export const huddleIntervalRecordSchema = huddleIntervalSettingsSchema.extend({
  node: huddleKeySchema,
  anchor: z.number().int().nonnegative().safe(),
  last: z.number().int().nonnegative().safe(),
});
export type HuddleIntervalRecord = z.infer<typeof huddleIntervalRecordSchema>;
export const huddleIntervalStateSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid(),
  schedules: z.array(huddleIntervalRecordSchema).max(HUDDLE_INTERVAL_LIMIT),
});

/** Fixed-duration UTC instants. Wall-clock rollback never repeats an occurrence. */
export function nextHuddleInterval(record: HuddleIntervalRecord, now: number) {
  const latest = Math.floor((now - record.anchor) / record.intervalMs);
  if (latest <= record.last) return null;
  const ordinal =
    record.missed === 'catch-up'
      ? Math.max(record.last + 1, latest - record.maxCatchUp + 1)
      : latest;
  return {
    ordinal,
    scheduledAt: new Date(record.anchor + ordinal * record.intervalMs).toISOString(),
    firstScheduledAt: new Date(record.anchor + (record.last + 1) * record.intervalMs).toISOString(),
    occurrences: record.missed === 'coalesce' ? ordinal - record.last : 1,
    skipped: record.missed === 'coalesce' ? 0 : ordinal - record.last - 1,
  };
}
