import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { agentHandleValueSchema } from './handle.js';
import { promptAgentComponent, reviewAgentComponent } from './prompt.js';

function owned(component: typeof promptAgentComponent, review: boolean) {
  return huddleComponentSchema.parse({
    ...component,
    id: review ? 'puddle.agent.review-spawned' : 'puddle.agent.prompt-spawned',
    title: review ? 'Review spawned agent' : 'Prompt spawned agent',
    description:
      'Reuse an agent spawned in this execution, including across bounded feedback rounds.',
    inputs: { ...component.inputs, agent: { schema: agentHandleValueSchema, scope: 'execution' } },
    parameters: { worktree: component.parameters.worktree, prompt: component.parameters.prompt },
  });
}

export const promptSpawnedAgentComponent = owned(promptAgentComponent, false);
export const reviewSpawnedAgentComponent = owned(reviewAgentComponent, true);
