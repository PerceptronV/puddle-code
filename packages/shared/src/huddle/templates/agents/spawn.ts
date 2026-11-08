import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { agentNodeParameters } from './prompt.js';

export const spawnAgentComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.agent.spawn',
  version: 1,
  category: 'script',
  title: 'Spawn agent',
  description:
    'Create an agent in an explicit project/worktree, send a prompt and pass its reply and handle onward.',
  inputs: { value: { schema: {} } },
  outputs: {
    completed: { schema: { type: 'string' } },
    agent: {
      schema: {
        type: 'object',
        properties: { runtime_id: { type: 'string' }, session_id: { type: 'string' } },
        required: ['runtime_id', 'session_id'],
        additionalProperties: false,
      },
    },
    turn: { schema: { type: 'string' }, emission: 'event', required: false },
  },
  parameters: {
    project: { title: 'Project', schema: { type: 'string', minLength: 1 }, editor: 'project' },
    worktree: agentNodeParameters.worktree,
    provider: { title: 'Provider', schema: { type: 'string', minLength: 1 }, editor: 'agent' },
    account: { title: 'Account', schema: { type: 'string', minLength: 1 }, editor: 'account' },
    mode: {
      title: 'Mode',
      schema: { type: 'string', enum: ['interactive', 'headless'] },
      default: 'interactive',
    },
    title: {
      title: 'Session title',
      schema: { type: 'string', minLength: 1, maxLength: 200 },
      default: 'Huddle agent',
    },
    prompt: agentNodeParameters.prompt,
  },
  capabilities: ['sessions'],
  entry: './run.ts',
  dependencies: ['./prompt.ts'],
});

export const spawnAgentSource = `import { HuddleNode } from 'puddlang/huddle';
import { formatPrompt } from './prompt.ts';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, bindings, puddlang, emit }) {
    const prompt = formatPrompt(String(parameters.prompt), inputs.value);
    if (!prompt.length) throw new Error('Prompt is empty after input substitution');
    const agent = await puddlang.spawn({
      project: bindings.project,
      worktree: bindings.worktree,
      agent: bindings.provider,
      account: bindings.account,
      mode: parameters.mode as 'interactive' | 'headless',
      title: String(parameters.title),
    });
    const reply = await agent.ask(prompt);
    await emit('turn', reply);
    return { completed: reply, agent: agent.handle };
  },
});
`;
