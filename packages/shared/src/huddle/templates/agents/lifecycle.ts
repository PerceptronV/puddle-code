import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { agentNodeParameters } from './prompt.js';
import { agentHandleValueSchema } from './handle.js';

export function lifecycleAgentComponent(action: 'resume' | 'restart') {
  return huddleComponentSchema.parse({
    format: 1,
    id: `puddle.agent.${action}`,
    version: 1,
    category: 'script',
    lifecycle: action,
    title: action === 'resume' ? 'Resume agent' : 'Restart agent',
    description:
      action === 'resume'
        ? 'Resume the selected stopped conversation using its existing account and worktree, then send a prompt.'
        : 'Stop the selected runtime and its terminals, resume the same conversation, then send a prompt. Terminal process state is lost.',
    inputs: { value: { schema: {} } },
    outputs: {
      agent: { schema: agentHandleValueSchema },
      completed: { schema: { type: 'string' } },
      turn: { schema: { type: 'string' }, emission: 'event', required: false },
    },
    parameters: agentNodeParameters,
    capabilities: ['sessions'],
    entry: './run.ts',
    dependencies: ['./prompt.ts'],
  });
}
export function lifecycleAgentSource(action: 'resume' | 'restart') {
  return `import { HuddleNode } from 'puddlang/huddle';
import { formatPrompt } from './prompt.ts';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, bindings, puddlang, emit }) {
    const agent = await puddlang.${action}(bindings.agent);
    const reply = await agent.ask(formatPrompt(String(parameters.prompt), inputs.value));
    await emit('turn', reply);
    return { agent: agent.handle, completed: reply };
  },
});
`;
}
