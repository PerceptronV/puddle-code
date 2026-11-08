import { huddleComponentSchema } from '../../../api/huddle/components.js';
import { promptAgentComponent, reviewAgentComponent } from './prompt.js';

export function nativeAgentComponent(review: boolean) {
  const base = review ? reviewAgentComponent : promptAgentComponent;
  return huddleComponentSchema.parse({
    ...base,
    id: review ? 'puddle.agent.native-review' : 'puddle.agent.native-prompt',
    title: review ? 'Review agent with native completion' : 'Prompt agent with native completion',
    description:
      'Continue once the ask result and its selected native completion trigger agree, within the same execution and feedback limits.',
    nativeCompletion: 'completion',
    parameters: {
      ...base.parameters,
      completion: {
        title: 'Completion trigger',
        description: 'Node id of a Turn completed trigger observing this exact agent and worktree.',
        schema: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  });
}
