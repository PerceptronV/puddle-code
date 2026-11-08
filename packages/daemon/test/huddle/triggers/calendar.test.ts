import { expect, it } from 'vitest';
import type { HuddleScheduleRecord } from '@puddle/shared';
import {
  dueScheduleOccurrences,
  nextScheduleDeadline,
  requireCalendarTimezone,
} from '../../../src/runtime/huddle/triggers/calendar/occurrences.js';

function schedule(
  timeZone = 'America/New_York',
  time = '02:30',
  through = '2026-03-07T12:00:00Z',
): Extract<HuddleScheduleRecord, { kind: 'calendar' }> {
  return {
    kind: 'calendar',
    node: 'clock',
    timeZone,
    time,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    missed: 'coalesce',
    maxCatchUp: 3,
    through: Date.parse(through),
  };
}
const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());

it('skips spring clock gaps and chooses only the earlier autumn overlap', () => {
  expect(iso(nextScheduleDeadline(schedule()))).toBe('2026-03-09T06:30:00.000Z');
  const fall = schedule('America/New_York', '01:30', '2026-10-31T12:00:00Z');
  expect(iso(nextScheduleDeadline(fall))).toBe('2026-11-01T05:30:00.000Z');
  fall.through = Date.parse('2026-11-01T05:30:00Z');
  expect(dueScheduleOccurrences(fall, Date.parse('2026-11-01T06:30:00Z'))).toEqual([]);
  expect(iso(nextScheduleDeadline(fall))).toBe('2026-11-02T06:30:00.000Z');
});
it('handles half-hour clock changes and skipped civil dates', () => {
  expect(
    iso(nextScheduleDeadline(schedule('Australia/Lord_Howe', '02:15', '2026-10-03T00:00:00Z'))),
  ).toBe('2026-10-04T15:15:00.000Z');
  expect(iso(nextScheduleDeadline(schedule('Pacific/Apia', '09:00', '2011-12-29T20:00:00Z')))).toBe(
    '2011-12-30T19:00:00.000Z',
  );
});
it('selects local weekdays and counts real missed occurrences across a DST gap', () => {
  const record = schedule();
  const now = Date.parse('2026-03-11T12:00:00Z');
  expect(dueScheduleOccurrences(record, now).map((event) => event.data)).toEqual([
    {
      firstScheduledAt: '2026-03-09T06:30:00.000Z',
      scheduledAt: '2026-03-11T06:30:00.000Z',
      occurrences: 3,
      skipped: 0,
    },
  ]);
  record.weekdays = [2];
  expect(iso(nextScheduleDeadline(record))).toBe('2026-03-10T06:30:00.000Z');
  expect(dueScheduleOccurrences(record, now)[0]!.data.occurrences).toBe(1);
});
it('bounds catch-up, labels skipped older occurrences and never repeats on clock rollback', () => {
  const record = schedule('UTC', '09:00', '2026-01-01T12:00:00Z');
  const now = Date.parse('2026-01-11T12:00:00Z');
  record.missed = 'catch-up';
  const events = dueScheduleOccurrences(record, now);
  expect(events.map((item) => item.data.skipped)).toEqual([7, 0, 0]);
  expect(events.map((item) => item.data.scheduledAt)).toEqual([
    '2026-01-09T09:00:00.000Z',
    '2026-01-10T09:00:00.000Z',
    '2026-01-11T09:00:00.000Z',
  ]);
  record.missed = 'skip';
  expect(dueScheduleOccurrences(record, now)[0]!.data).toMatchObject({
    occurrences: 1,
    skipped: 9,
  });
  expect(dueScheduleOccurrences(record, record.through - 1)).toEqual([]);
  expect(() => dueScheduleOccurrences(record, Date.parse('2028-01-01T00:00:00Z'))).toThrow(
    '366 days',
  );
});
it('rejects unknown and offset-only zones and treats UTC explicitly', () => {
  expect(() => requireCalendarTimezone('Europe/London')).not.toThrow();
  expect(() => requireCalendarTimezone('UTC')).not.toThrow();
  expect(() => requireCalendarTimezone('Invalid/Zone')).toThrow();
  expect(() => requireCalendarTimezone('+02:00')).toThrow('named IANA');
});
