import { Temporal } from '@js-temporal/polyfill';
import type { HuddleCalendarSettings, HuddleScheduleRecord } from '@puddle/shared';

// Bound work after host sleep/clock jumps; never silently discard a larger gap.
export const CALENDAR_LOOKBACK_DAYS = 366;
const dayMs = 86_400_000;

export function requireCalendarTimezone(timeZone: string) {
  if (/^[+-]/.test(timeZone)) throw new Error('Calendar requires a named IANA timezone');
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
}

/** Pick the earlier overlap, but skip gaps rather than shift the requested wall time. */
function occurrence(settings: HuddleCalendarSettings, date: Temporal.PlainDate) {
  if (!settings.weekdays.includes(date.dayOfWeek)) return null;
  const local = date.toPlainDateTime(settings.time);
  const zoned = local.toZonedDateTime(settings.timeZone, { disambiguation: 'earlier' });
  return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : null;
}
function dateAt(settings: HuddleCalendarSettings, instant: number) {
  return Temporal.Instant.fromEpochMilliseconds(instant)
    .toZonedDateTimeISO(settings.timeZone)
    .toPlainDate();
}

export function nextScheduleDeadline(record: HuddleScheduleRecord): number | null {
  if (record.kind === 'date') return record.disposition === 'pending' ? record.due : null;
  let date = dateAt(record, record.through);
  // Two weeks cover a selected weekday skipped by a civil-time transition.
  for (let i = 0; i < 15; i++, date = date.add({ days: 1 })) {
    const at = occurrence(record, date);
    if (at !== null && at > record.through) return at;
  }
  throw new Error('Calendar has no valid occurrence within the next two weeks');
}

export interface ScheduleOccurrence {
  at: number;
  data: { scheduledAt: string; firstScheduledAt: string; occurrences: number; skipped: number };
}
const iso = (at: number) => new Date(at).toISOString();

/** A bounded plan for one wake-up; admission still checks the exact retained progress. */
export function dueScheduleOccurrences(
  record: HuddleScheduleRecord,
  now: number,
): ScheduleOccurrence[] {
  if (record.kind === 'date') {
    return record.disposition !== 'pending' || record.due > now
      ? []
      : [
          {
            at: record.due,
            data: {
              scheduledAt: iso(record.due),
              firstScheduledAt: iso(record.due),
              occurrences: 1,
              skipped: 0,
            },
          },
        ];
  }
  if (now <= record.through) return [];
  if (now - record.through > CALENDAR_LOOKBACK_DAYS * dayMs)
    throw new Error(
      'Calendar observation gap exceeds 366 days; inspect accepted work, then Stop/Start to start from now',
    );
  let date = dateAt(record, record.through);
  const end = dateAt(record, now),
    due: number[] = [];
  for (let i = 0; Temporal.PlainDate.compare(date, end) <= 0; i++, date = date.add({ days: 1 })) {
    if (i > CALENDAR_LOOKBACK_DAYS + 2)
      throw new Error('Calendar observation exceeds its bounded date range');
    const at = occurrence(record, date);
    if (at !== null && at > record.through && at <= now) due.push(at);
  }
  if (!due.length) return [];
  const selected = record.missed === 'catch-up' ? due.slice(-record.maxCatchUp) : due.slice(-1);
  return selected.map((at, index) => ({
    at,
    data: {
      scheduledAt: iso(at),
      firstScheduledAt: iso(index === 0 ? due[0]! : at),
      occurrences: record.missed === 'coalesce' ? due.length : 1,
      skipped: record.missed === 'coalesce' || index > 0 ? 0 : due.length - selected.length,
    },
  }));
}
