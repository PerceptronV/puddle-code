import { huddleComponentSchema } from '../../../api/huddle/components.js';

export const conditionComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.flow.condition',
  version: 1,
  category: 'script',
  title: 'Condition',
  description:
    'Compare a field with a JSON value and send the original input to exactly one branch. Missing fields fail instead of choosing a branch.',
  entry: './run.ts',
  inputs: { value: { schema: {} } },
  outputs: {
    matched: { schema: {}, required: false, title: 'Matched' },
    unmatched: { schema: {}, required: false, title: 'Unmatched' },
  },
  parameters: {
    path: {
      title: 'Field path',
      description:
        'JSON list of field names or array indexes, for example ["review", "complete"]. An empty list compares the whole input.',
      schema: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 128 },
        maxItems: 32,
      },
      editor: 'json',
      default: ['complete'],
    },
    equals: {
      title: 'Equals',
      description:
        'Compare JSON values without coercion. Object field order does not matter; array order does.',
      schema: {},
      editor: 'json',
      default: true,
    },
  },
});
export const conditionSource = `import { HuddleNode } from 'puddlang/huddle';
import { isDeepStrictEqual } from 'node:util';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, signal }) {
    signal.throwIfAborted();
    let selected: unknown = inputs.value;
    for (const field of parameters.path as string[]) {
      if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, field))
        throw new Error('Missing condition field: ' + field);
      selected = (selected as Record<string, unknown>)[field];
    }
    const port = isDeepStrictEqual(selected, parameters.equals) ? 'matched' : 'unmatched';
    return { [port]: inputs.value! };
  },
});
`;

export const mergeComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.flow.merge',
  version: 1,
  category: 'script',
  title: 'Merge',
  description:
    'Forward each arriving alternative independently. Does not wait for both inputs, combine values or deduplicate arrivals. Connect mutually exclusive branches to continue once.',
  entry: './run.ts',
  activation: 'any',
  inputs: { left: { schema: {} }, right: { schema: {} } },
  outputs: { completed: { schema: {} } },
});
export const mergeSource = `import { HuddleNode } from 'puddlang/huddle';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, signal }) {
    signal.throwIfAborted();
    const port = Object.hasOwn(inputs, 'left') ? 'left' : 'right';
    return { completed: inputs[port]! };
  },
});
`;

export const joinComponent = huddleComponentSchema.parse({
  ...mergeComponent,
  id: 'puddle.flow.join',
  title: 'Join',
  description:
    'Wait for both branches of the same execution and activation, then return {left, right}. Use a shared fan-out; separate triggers or event emissions cannot join. Use Merge for mutually exclusive branches.',
  activation: 'all',
  outputs: {
    completed: {
      schema: {
        type: 'object',
        properties: { left: {}, right: {} },
        required: ['left', 'right'],
        additionalProperties: false,
      },
    },
  },
});
export const joinSource = `import { HuddleNode } from 'puddlang/huddle';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, signal }) {
    signal.throwIfAborted();
    return { completed: { left: inputs.left!, right: inputs.right! } };
  },
});
`;
