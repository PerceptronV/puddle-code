import type { HuddleInstallTemplate } from '../../api/huddle/templates.js';
import { huddleAgentTemplates, huddleAgentTemplateFiles } from './agents.js';
import { fileReportComponent, fileReportFiles } from './readouts/file.js';
import { huddleFlowTemplates, huddleFlowTemplateFiles } from './flow/catalogue.js';
import { huddleBuiltinCopyFiles } from './builtins.js';

export const huddleNodeTemplates = [
  ...huddleFlowTemplates.map(({ template, component, minor }) => ({ template, component, minor })),
  ...huddleAgentTemplates,
  { template: 'write-report', component: fileReportComponent, minor: 22 },
] as const;
export function huddleTemplateFiles(
  template: HuddleInstallTemplate['template'],
  builtin?: HuddleInstallTemplate['builtin'],
) {
  if (template === 'builtin') {
    if (!builtin) throw new Error('Choose a pinned built-in component');
    return huddleBuiltinCopyFiles(builtin);
  }
  const flow = huddleFlowTemplateFiles(template);
  if (flow) return flow;
  return template === 'write-report'
    ? { component: fileReportComponent, files: fileReportFiles }
    : huddleAgentTemplateFiles(template);
}
