import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, it } from 'vitest';
import { agentPromptSource } from '../../src/huddle/templates/agents/prompt.js';

// Exercise the exact editable asset copied into a user's component directory.
const module = { exports: {} as { formatPrompt: (template: string, input: unknown) => string } };
runInNewContext(transformSync(agentPromptSource, { loader: 'ts', format: 'cjs' }).code, {
  module,
  TextEncoder,
});
const format = module.exports.formatPrompt;

it('substitutes JSON values and own fields without recursively evaluating inserted prompt text', () => {
  expect(format('Review: {{input}}', { complete: false, feedback: 'fix' })).toBe(
    'Review: {"complete":false,"feedback":"fix"}',
  );
  expect(format('Task: {{ input.task }}', { task: '$(command) {{input.secret}}' })).toBe(
    'Task: $(command) {{input.secret}}',
  );
  expect(format('{{input.a.b}}', { a: { b: false } })).toBe('false');
  expect(() => format('{{input.missing}}', {})).toThrow('Missing prompt input field');
  expect(() => format('{{input.inherited}}', Object.create({ inherited: 'hidden' }))).toThrow(
    'Missing prompt input field',
  );
});

it('bounds expanded UTF-8 prompts before assembling repeated substitutions', () => {
  expect(format('{{input}}', 'x'.repeat(128 * 1024))).toHaveLength(128 * 1024);
  expect(() => format('{{input}}{{input}}', 'x'.repeat(100_000))).toThrow('byte limit');
  expect(() => format('{{input}}', '界'.repeat(50_000))).toThrow('byte limit');
  expect(() => format('x'.repeat(128 * 1024 + 1), null)).toThrow('byte limit');
});
