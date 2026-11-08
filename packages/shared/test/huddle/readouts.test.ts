import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  huddleComponentSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

it('preserves old owners and requires readout support to adopt newer owners', () => {
  const { readouts: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(supportsHuddleRuntime(old)).toBe(true);
  expect(supportsHuddleRuntime({ ...old, readouts: 2 })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, old)).toBe(true);
  candidate.roles.huddle = old;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});

it('requires explicit delivery policy on local readouts and rejects premature event outputs', () => {
  const component = {
    format: 1,
    id: 'fixture.readout.delivery',
    version: 1,
    category: 'readout',
    title: 'Delivery',
    entry: 'run.ts',
    inputs: { value: { schema: {} } },
  };
  expect(huddleComponentSchema.safeParse(component).success).toBe(false);
  const readout = { idempotent: false, reconciliation: 'none', cancellation: 'signal' };
  expect(huddleComponentSchema.safeParse({ ...component, readout }).success).toBe(true);
  expect(
    huddleComponentSchema.safeParse({ ...component, readout, category: 'script' }).success,
  ).toBe(false);
  expect(
    huddleComponentSchema.safeParse({
      ...component,
      readout,
      outputs: { early: { schema: {}, emission: 'event' } },
    }).success,
  ).toBe(false);
});
