import { huddleComponentSchema } from '../../../api/huddle/components.js';

export const agentNodeParameters = {
  worktree: {
    title: 'Worktree',
    schema: { type: 'string' as const, minLength: 1 },
    editor: 'worktree' as const,
  },
  agent: {
    title: 'Agent session',
    schema: { type: 'string' as const, minLength: 1 },
    editor: 'session' as const,
  },
  prompt: {
    title: 'Prompt',
    schema: { type: 'string' as const, minLength: 1, maxLength: 131072 },
    editor: 'prompt' as const,
    description: 'Use {{input}} for the incoming value, or {{input.field}} for a field.',
    default: '{{input}}',
  },
};
const review = {
  type: 'object' as const,
  properties: { complete: { type: 'boolean' as const }, feedback: { type: 'string' as const } },
  required: ['complete', 'feedback'],
  additionalProperties: false,
};
export const promptAgentComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.agent.prompt',
  version: 1,
  category: 'script',
  title: 'Prompt agent',
  description: 'Send a prompt to an existing agent and pass its completed reply onward.',
  inputs: { value: { schema: {} } },
  outputs: {
    completed: { schema: { type: 'string' } },
    turn: { schema: { type: 'string' }, emission: 'event', required: false },
  },
  parameters: agentNodeParameters,
  capabilities: ['sessions'],
  entry: './run.ts',
  dependencies: ['./prompt.ts'],
});
export const reviewAgentComponent = huddleComponentSchema.parse({
  ...promptAgentComponent,
  id: 'puddle.agent.review',
  title: 'Review agent',
  description: 'Ask an existing agent for structured approval and feedback.',
  parameters: {
    ...agentNodeParameters,
    prompt: {
      ...agentNodeParameters.prompt,
      default:
        'Review this work. Set complete to true only when no further changes are needed; otherwise explain the required changes in feedback.\n\n{{input}}',
    },
  },
  outputs: {
    completed: { schema: review },
    turn: { schema: review, emission: 'event', required: false },
  },
});

/** Copied into each component, so prompt formatting remains ordinary editable TypeScript. */
export const agentPromptSource = String.raw`export function formatPrompt(template: string, input: unknown): string {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(template).length;
  if (bytes > 128 * 1024) throw new Error('Prompt exceeds its byte limit');
  return template.replace(/\{\{\s*input((?:\.[a-zA-Z0-9_-]+)*)\s*\}\}/g, (match, path: string) => {
    let value = input;
    for (const field of path.split('.').filter(Boolean)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, field))
        throw new Error('Missing prompt input field: ' + path);
      value = (value as Record<string, unknown>)[field];
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) throw new Error('Missing prompt input value');
    bytes += encoder.encode(text).length - encoder.encode(match).length;
    if (bytes > 128 * 1024) throw new Error('Prompt exceeds its byte limit');
    return text;
  });
}
`;
export function agentNodeSource(structured: boolean, spawned = false) {
  return `import { HuddleNode } from 'puddlang/huddle';
${structured ? "import { z } from 'zod';\n" : ''}import { formatPrompt } from './prompt.ts';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, bindings, puddlang, emit }) {
    ${
      spawned
        ? `const handle = inputs.agent as { runtime_id: string; session_id: string };
    const agent = await puddlang.attach(handle.runtime_id);
    if (agent.handle.session_id !== handle.session_id) throw new Error('Agent handle session changed');`
        : 'const agent = await puddlang.attach(bindings.agent);'
    }
    const prompt = formatPrompt(String(parameters.prompt), inputs.value);
    const reply = await agent.ask(${structured ? '{ prompt, schema: z.object({ complete: z.boolean(), feedback: z.string() }).strict() }' : 'prompt'});
    await emit('turn', reply);
    return { completed: reply };
  },
});
`;
}
