import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  nextHuddleInterval,
  type HuddleIntervalRecord,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

const base: HuddleIntervalRecord = {
  node: 'clock',
  anchor: 10000,
  last: 0,
  intervalMs: 1000,
  missed: 'coalesce',
  maxCatchUp: 3,
};
it('anchors fixed UTC intervals and never replays after a clock rollback', () => {
  expect(nextHuddleInterval(base, 10999)).toBeNull();
  expect(nextHuddleInterval(base, 11000)).toMatchObject({
    ordinal: 1,
    occurrences: 1,
    skipped: 0,
    scheduledAt: '1970-01-01T00:00:11.000Z',
  });
  expect(nextHuddleInterval({ ...base, last: 5 }, 12000)).toBeNull();
});
it('coalesces a gap, skips older occurrences, or catches up within an explicit bound', () => {
  expect(nextHuddleInterval(base, 20000)).toMatchObject({
    ordinal: 10,
    occurrences: 10,
    skipped: 0,
  });
  expect(nextHuddleInterval({ ...base, missed: 'skip' }, 20000)).toMatchObject({
    ordinal: 10,
    occurrences: 1,
    skipped: 9,
  });
  expect(nextHuddleInterval({ ...base, missed: 'catch-up' }, 20000)).toMatchObject({
    ordinal: 8,
    occurrences: 1,
    skipped: 7,
  });
  expect(nextHuddleInterval({ ...base, missed: 'catch-up', last: 8 }, 20000)).toMatchObject({
    ordinal: 9,
    occurrences: 1,
    skipped: 0,
  });
});
it('preserves old owner support and refuses timer ownership on an old candidate', () => {
  const { timers: _, ...legacy } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(legacy)).toBe(true);
  expect(supportsHuddleRuntime({ ...legacy, timers: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, legacy)).toBe(true);
  candidate.roles.huddle = legacy;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
