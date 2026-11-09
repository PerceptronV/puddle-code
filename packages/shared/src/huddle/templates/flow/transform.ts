import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { agentPromptSource } from '../prompts/source.js';

export const transformComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.flow.transform',
  version: 1,
  category: 'script',
  title: 'Transform',
  description:
    'An editable script for mapping incoming data. Open script to replace the initial identity transform and update its port schemas.',
  entry: './run.ts',
  inputs: { value: { schema: {} } },
  outputs: { completed: { schema: {} } },
});
export const transformSource = `import { HuddleNode } from 'puddlang/huddle';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, signal }) {
    signal.throwIfAborted();
    // Replace this identity transform; returned values must match completion ports.
    return { completed: inputs.value! };
  },
});
`;

export const formatComponent = huddleComponentSchema.parse({
  ...transformComponent,
  id: 'puddle.flow.format',
  title: 'Format text',
  description:
    'Build text from incoming data using the same field substitution as agent prompts. Missing fields fail without forwarding a partial result.',
  parameters: {
    template: {
      title: 'Template',
      description:
        'Use {{input}} for the incoming value, or {{input.field}} for a field. Objects and arrays become JSON; no code or shell expressions are evaluated.',
      schema: { type: 'string', maxLength: 131072 },
      editor: 'prompt',
      default: '{{input}}',
    },
  },
  outputs: { completed: { schema: { type: 'string' } } },
  dependencies: ['./prompt.ts'],
});
export const formatFiles = {
  'prompt.ts': agentPromptSource,
  'run.ts': `import { HuddleNode } from 'puddlang/huddle';
import { formatPrompt } from './prompt.ts';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, signal }) {
    signal.throwIfAborted();
    return { completed: formatPrompt(String(parameters.template), inputs.value) };
  },
});
`,
};
