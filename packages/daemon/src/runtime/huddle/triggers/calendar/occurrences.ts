import { Temporal } from '@js-temporal/polyfill';
import type {
  HuddleCalendarSettings,
  HuddleCalendarDateSettings,
  HuddleScheduleRecord,
} from '@puddle/shared';

// Bound work after host sleep/clock jumps; never silently discard a larger gap.
export const CALENDAR_LOOKBACK_DAYS = 366;
const dayMs = 86_400_000;
// Leap-day recurrence can span eight years across a non-leap century (2096–2104).
// Search months, not days, and retain a finite nine-year observation range.
const CALENDAR_DATE_MONTHS = 108;
type CivilSettings = HuddleCalendarSettings | HuddleCalendarDateSettings;

export function requireCalendarTimezone(timeZone: string) {
  if (/^[+-]/.test(timeZone)) throw new Error('Calendar requires a named IANA timezone');
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
}

/** Pick the earlier overlap, but skip gaps rather than shift the requested wall time. */
function occurrence(settings: CivilSettings, date: Temporal.PlainDate) {
  if ('weekdays' in settings && !settings.weekdays.includes(date.dayOfWeek)) return null;
  const local = date.toPlainDateTime(settings.time);
  const zoned = local.toZonedDateTime(settings.timeZone, { disambiguation: 'earlier' });
  return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : null;
}
function dateAt(settings: CivilSettings, instant: number) {
  return Temporal.Instant.fromEpochMilliseconds(instant)
    .toZonedDateTimeISO(settings.timeZone)
    .toPlainDate();
}

function* monthlyDates(settings: HuddleCalendarDateSettings, start: Temporal.PlainDate) {
  let month = start.toPlainYearMonth();
  for (let i = 0; i <= CALENDAR_DATE_MONTHS; i++, month = month.add({ months: 1 })) {
    if (settings.months.includes(month.month) && settings.day <= month.daysInMonth)
      yield month.toPlainDate({ day: settings.day });
  }
}

export function nextScheduleDeadline(record: HuddleScheduleRecord): number | null {
  if (record.kind === 'date') return record.disposition === 'pending' ? record.due : null;
  let date = dateAt(record, record.through);
  if (record.kind === 'calendar-date') {
    for (const candidate of monthlyDates(record, date)) {
      const at = occurrence(record, candidate);
      if (at !== null && at > record.through) return at;
    }
    throw new Error('Calendar has no valid occurrence within the next nine years');
  }
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
  const limit = record.kind === 'calendar-date' ? 9 * 366 : CALENDAR_LOOKBACK_DAYS;
  if (now - record.through > limit * dayMs)
    throw new Error(
      `Calendar observation gap exceeds ${limit} days; inspect accepted work, then Stop/Start to start from now`,
    );
  let date = dateAt(record, record.through);
  const end = dateAt(record, now),
    due: number[] = [];
  if (record.kind === 'calendar-date') {
    const months = (end.year - date.year) * 12 + end.month - date.month;
    if (months > CALENDAR_DATE_MONTHS)
      throw new Error(
        'Calendar observation gap exceeds nine years; inspect accepted work, then Stop/Start',
      );
    for (const candidate of monthlyDates(record, date)) {
      if (Temporal.PlainDate.compare(candidate, end) > 0) break;
      const at = occurrence(record, candidate);
      if (at !== null && at > record.through && at <= now) due.push(at);
    }
  } else {
    for (let i = 0; Temporal.PlainDate.compare(date, end) <= 0; i++, date = date.add({ days: 1 })) {
      if (i > CALENDAR_LOOKBACK_DAYS + 2)
        throw new Error('Calendar observation exceeds its bounded date range');
      const at = occurrence(record, date);
      if (at !== null && at > record.through && at <= now) due.push(at);
    }
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
