import { expect, it } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES, supportsHuddleRuntime } from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

it('preserves old owners and requires completion support before adopting a new owner', () => {
  const { completionEvents: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime(HUDDLE_RUNTIME_CAPABILITIES)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, completionEvents: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
