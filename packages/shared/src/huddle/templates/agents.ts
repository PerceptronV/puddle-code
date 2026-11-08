import { lifecycleAgentComponent, lifecycleAgentSource } from './agents/lifecycle.js';
import {
  agentNodeSource,
  agentPromptSource,
  promptAgentComponent,
  reviewAgentComponent,
} from './agents/prompt.js';
import { spawnAgentComponent, spawnAgentSource } from './agents/spawn.js';
import { promptSpawnedAgentComponent, reviewSpawnedAgentComponent } from './agents/owned.js';
import type { HuddleInstallTemplate } from '../../api/huddle/templates.js';

export const huddleAgentTemplates = [
  { template: 'resume-agent', component: lifecycleAgentComponent('resume'), minor: 14 },
  { template: 'restart-agent', component: lifecycleAgentComponent('restart'), minor: 14 },
  { template: 'prompt-agent', component: promptAgentComponent, minor: 3 },
  { template: 'review-agent', component: reviewAgentComponent, minor: 3 },
  { template: 'spawn-agent', component: spawnAgentComponent, minor: 8 },
  { template: 'prompt-spawned-agent', component: promptSpawnedAgentComponent, minor: 9 },
  { template: 'review-spawned-agent', component: reviewSpawnedAgentComponent, minor: 9 },
] as const;
export function huddleAgentTemplateFiles(template: HuddleInstallTemplate['template']) {
  const structured = template === 'review-agent' || template === 'review-spawned-agent';
  const component = huddleAgentTemplates.find((item) => item.template === template)?.component;
  if (!component) throw new Error('Unknown huddle agent template');
  return {
    component,
    files: {
      'node.json': JSON.stringify(component, null, 2) + '\n',
      'run.ts':
        template === 'resume-agent' || template === 'restart-agent'
          ? lifecycleAgentSource(template === 'resume-agent' ? 'resume' : 'restart')
          : template === 'spawn-agent'
            ? spawnAgentSource
            : agentNodeSource(structured, template.endsWith('-spawned-agent')),
      'prompt.ts': agentPromptSource,
    },
  };
}
