import type { TabRef } from '@puddle/shared';

/** Workspace titles use the project name; an isolated pane uses its active tab's name. */
export function workspaceTitle(project: string, tab?: TabRef | null, sessionName?: string): string {
  if (!tab) return project;
  if (tab.type !== 'editor') return sessionName ?? tab.session.slice(0, 8);
  return tab.tab.path.split('/').at(-1) || tab.tab.path;
}
