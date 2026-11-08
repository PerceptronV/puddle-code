import { expect, it } from 'vitest';
import {
  huddleComponentSchema,
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  canAdoptHuddle,
  daemonRuntimeCapabilities,
  promptSpawnedAgentComponent,
  validateHuddleGraph,
} from '../../src/index.js';
import { reviewHuddleFixture } from '../helpers/huddle.js';

it('requires immutable execution inputs to accompany normal required inputs with all-input activation', () => {
  const base = promptSpawnedAgentComponent;
  expect(huddleComponentSchema.safeParse(base).success).toBe(true);
  for (const invalid of [
    { ...base, activation: 'any' },
    { ...base, inputs: { agent: base.inputs.agent } },
    { ...base, inputs: { ...base.inputs, agent: { ...base.inputs.agent, required: false } } },
    { ...base, outputs: { completed: { schema: {}, scope: 'execution' } } },
  ])
    expect(huddleComponentSchema.safeParse(invalid).success).toBe(false);
  const { definition, components } = reviewHuddleFixture();
  const coder = components.get('coder')!;
  components.set(
    'coder',
    huddleComponentSchema.parse({
      ...coder,
      inputs: { ...coder.inputs, stable: { schema: {}, scope: 'execution' } },
    }),
  );
  definition.edges.find((edge) => edge.feedback)!.to.port = 'stable';
  expect(
    validateHuddleGraph(definition, components).some(
      (item) => item.code === 'feedback_execution_input',
    ),
  ).toBe(true);
});

it('negotiates retained inputs without removing older runtime support', () => {
  expect(supportsHuddleRuntime(HUDDLE_RUNTIME_CAPABILITIES)).toBe(true);
  expect(supportsHuddleRuntime({ ...HUDDLE_RUNTIME_CAPABILITIES, executionInputs: 2 })).toBe(false);
  const older = { ...HUDDLE_RUNTIME_CAPABILITIES };
  delete older.executionInputs;
  expect(supportsHuddleRuntime(older)).toBe(true);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, older)).toBe(true);
  delete candidate.roles.huddle!.executionInputs;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});
