import type { HuddleInstallTemplate } from '../../api/huddle/templates.js';
import { huddleAgentTemplates, huddleAgentTemplateFiles } from './agents.js';
import { fileReportComponent, fileReportFiles } from './readouts/file.js';

export const huddleNodeTemplates = [
  ...huddleAgentTemplates,
  { template: 'write-report', component: fileReportComponent, minor: 22 },
] as const;
export function huddleTemplateFiles(template: HuddleInstallTemplate['template']) {
  return template === 'write-report'
    ? { component: fileReportComponent, files: fileReportFiles }
    : huddleAgentTemplateFiles(template);
}
