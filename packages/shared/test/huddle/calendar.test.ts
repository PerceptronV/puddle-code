import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleDateSettingsSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

it('adopts interval-only owners but blocks a calendar owner on an older candidate', () => {
  const { calendar: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, calendar: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
it('requires an exact one-off instant with seconds and optional milliseconds', () => {
  for (const at of ['2026-01-01T09:00:00Z', '2026-01-01T09:00:00.123+01:30'])
    expect(huddleDateSettingsSchema.safeParse({ at, past: 'fire' }).success).toBe(true);
  for (const at of ['2026-01-01T09:00', '2026-02-30T09:00:00Z', '2026-01-01T09:00:00.123456Z'])
    expect(huddleDateSettingsSchema.safeParse({ at, past: 'fire' }).success).toBe(false);
});
