import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleComponentSchema,
  huddleTriggerCursorSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

it('preserves owners without custom triggers and gates adoption of supporting owners', () => {
  const { customTriggers: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, customTriggers: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
it('requires explicit local subscription policy and bounded cursor state', () => {
  const component = {
    format: 1,
    id: 'fixture.trigger.custom',
    version: 1,
    category: 'trigger',
    title: 'Custom',
    entry: './run.ts',
    outputs: { event: { schema: {} } },
  };
  expect(huddleComponentSchema.safeParse(component).success).toBe(false);
  expect(
    huddleComponentSchema.safeParse({ ...component, trigger: { resume: 'continue' } }).success,
  ).toBe(true);
  expect(huddleTriggerCursorSchema.safeParse('x'.repeat(64 * 1024)).success).toBe(false);
  expect(huddleTriggerCursorSchema.parse({ after: 1 })).toEqual({ after: 1 });
});
