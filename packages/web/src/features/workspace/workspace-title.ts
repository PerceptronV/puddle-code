/**
 * The browser/Electron window title for a project workspace. Waiting state is
 * prominent, but never replaces the host identity — several Puddle windows can
 * show the same project name while controlling different machines.
 */
export function workspaceTitle(project: string, host: string, waiting: number): string {
  return waiting > 0 ? `● ${waiting} waiting — ${project} (${host})` : `${project} — ${host}`;
}
