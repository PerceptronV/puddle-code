import { expect, it } from 'vitest';
import { huddleDefinitionSchema } from '@puddle/shared';
import {
  initialHuddleVariables,
  parseHuddleVariables,
  parseHuddleInput,
} from '../../src/features/huddle/execution/forms';

const definition = huddleDefinitionSchema.parse({
  format: 1,
  id: 'a'.repeat(32),
  name: 'Review',
  nodes: [],
  edges: [],
  variables: {
    worktree: { schema: { type: 'string' }, editor: 'worktree' },
    rounds: { schema: { type: 'number' }, default: 3 },
    optional: { schema: { type: 'string' }, required: false },
  },
});
it('shows declared defaults and requires a valid explicit worktree variable', () => {
  expect(JSON.parse(initialHuddleVariables(definition))).toEqual({ rounds: 3 });
  expect(() => parseHuddleVariables(definition, '{}')).toThrow();
  expect(() => parseHuddleVariables(definition, '{"worktree":42}')).toThrow();
  expect(parseHuddleVariables(definition, '{"worktree":"/project","rounds":2}')).toEqual({
    worktree: '/project',
    rounds: 2,
  });
  expect(() => parseHuddleVariables(definition, '{"worktree":"/project","extra":true}')).toThrow();
});
it('accepts JSON primitives and structures while rejecting malformed and unbounded input', () => {
  expect(parseHuddleInput('null')).toBeNull();
  expect(parseHuddleInput('{"prompt":"Review","items":[1,false]}')).toEqual({
    prompt: 'Review',
    items: [1, false],
  });
  expect(() => parseHuddleInput('undefined')).toThrow();
  expect(() => parseHuddleInput('1e999')).toThrow();
  expect(() => parseHuddleInput(JSON.stringify('x'.repeat(2_000_000)))).toThrow();
});
