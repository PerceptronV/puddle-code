import { z } from 'zod';
import { huddleKeySchema } from '../../../api/huddle/values.js';

export const HUDDLE_CALENDAR_LIMIT = 32;
export const huddleCalendarSettingsSchema = z.strictObject({
  timeZone: z.string().min(1).max(100),
  time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'Weekdays must be unique'),
  missed: z.enum(['coalesce', 'skip', 'catch-up']),
  maxCatchUp: z.number().int().min(1).max(64),
});
export const huddleDateSettingsSchema = z.strictObject({
  at: z.iso
    .datetime({ offset: true, precision: 3 })
    .or(z.iso.datetime({ offset: true, precision: 0 })),
  past: z.enum(['fire', 'skip']),
});
export const huddleCalendarDateSettingsSchema = huddleCalendarSettingsSchema
  .omit({ weekdays: true })
  .extend({
    months: z
      .array(z.number().int().min(1).max(12))
      .min(1)
      .max(12)
      .refine((months) => new Set(months).size === months.length, 'Months must be unique'),
    day: z.number().int().min(1).max(31),
  })
  .refine(
    ({ months, day }) =>
      months.some((month) => day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!),
    'Selected months have no such day',
  );
const instant = z.number().int().nonnegative().max(8640000000000000);
export const huddleScheduleRecordSchema = z.discriminatedUnion('kind', [
  huddleCalendarSettingsSchema.extend({
    kind: z.literal('calendar'),
    node: huddleKeySchema,
    through: instant,
  }),
  huddleCalendarDateSettingsSchema.safeExtend({
    kind: z.literal('calendar-date'),
    node: huddleKeySchema,
    through: instant,
  }),
  huddleDateSettingsSchema.extend({
    kind: z.literal('date'),
    node: huddleKeySchema,
    due: instant,
    disposition: z.enum(['pending', 'admitted', 'skipped']),
  }),
]);
export type HuddleScheduleRecord = z.infer<typeof huddleScheduleRecordSchema>;
export type HuddleCalendarSettings = z.infer<typeof huddleCalendarSettingsSchema>;
export type HuddleCalendarDateSettings = z.infer<typeof huddleCalendarDateSettingsSchema>;
export const huddleScheduleStateSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid(),
  schedules: z.array(huddleScheduleRecordSchema).max(HUDDLE_CALENDAR_LIMIT),
});
