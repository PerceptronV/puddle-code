import {
  agentNodeSource,
  agentPromptSource,
  promptAgentComponent,
  reviewAgentComponent,
} from './agents/prompt.js';
import { spawnAgentComponent, spawnAgentSource } from './agents/spawn.js';
import type { HuddleInstallTemplate } from '../../api/huddle/templates.js';

export const huddleAgentTemplates = [
  { template: 'prompt-agent', component: promptAgentComponent, minor: 3 },
  { template: 'review-agent', component: reviewAgentComponent, minor: 3 },
  { template: 'spawn-agent', component: spawnAgentComponent, minor: 8 },
] as const;
export function huddleAgentTemplateFiles(template: HuddleInstallTemplate['template']) {
  const structured = template === 'review-agent';
  const component =
    template === 'spawn-agent'
      ? spawnAgentComponent
      : structured
        ? reviewAgentComponent
        : promptAgentComponent;
  return {
    component,
    files: {
      'node.json': JSON.stringify(component, null, 2) + '\n',
      'run.ts': template === 'spawn-agent' ? spawnAgentSource : agentNodeSource(structured),
      'prompt.ts': agentPromptSource,
    },
  };
}
