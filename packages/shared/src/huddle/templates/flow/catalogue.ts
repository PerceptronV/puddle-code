import type { HuddleInstallTemplate } from '../../../api/huddle/templates.js';
import { transformComponent, transformSource, formatComponent, formatFiles } from './transform.js';
import {
  conditionComponent,
  conditionSource,
  mergeComponent,
  mergeSource,
  joinComponent,
  joinSource,
} from './routing.js';

export const huddleFlowTemplates = [
  {
    template: 'transform',
    component: transformComponent,
    files: { 'run.ts': transformSource },
    minor: 25,
  },
  { template: 'format-text', component: formatComponent, files: formatFiles, minor: 25 },
  {
    template: 'condition',
    component: conditionComponent,
    files: { 'run.ts': conditionSource },
    minor: 25,
  },
  { template: 'merge', component: mergeComponent, files: { 'run.ts': mergeSource }, minor: 25 },
  { template: 'join', component: joinComponent, files: { 'run.ts': joinSource }, minor: 25 },
] as const;

export function huddleFlowTemplateFiles(template: HuddleInstallTemplate['template']) {
  const item = huddleFlowTemplates.find((item) => item.template === template);
  if (!item) return undefined;
  return {
    component: item.component,
    files: { 'node.json': JSON.stringify(item.component, null, 2) + '\n', ...item.files },
  };
}
