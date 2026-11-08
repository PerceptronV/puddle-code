import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleSessionSettingsSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

it('preserves old owners but prevents an older candidate adopting session subscriptions', () => {
  const { sessionEvents: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, sessionEvents: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
it('requires bounded explicit observation settings and excludes huddle echo subscriptions', () => {
  const settings = {
    worktree: '/project',
    kinds: ['agent'],
    events: ['status'],
    statuses: ['waiting_input'],
  };
  expect(huddleSessionSettingsSchema.safeParse(settings).success).toBe(true);
  for (const patch of [
    { worktree: '' },
    { session: '' },
    { kinds: ['huddle'] },
    { events: ['turn_completed'] },
    { statuses: [] },
  ])
    expect(huddleSessionSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false);
});
