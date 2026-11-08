import {
  desktopArrangementPlanSchema,
  uiStateSnapshotSchema,
  type DesktopArrangementPlanCommand,
} from '@puddle/shared';
import { arrangementViews, projectWindowSnapshot, savedWindowSnapshot } from './content';
import { retainArrangementDrafts, type PlannedWindow } from './drafts';

/** Pure renderer planning, using shell-selected identities and freshly sealed working sets. */
export function planWindowArrangement(
  command: DesktopArrangementPlanCommand,
  sessionProjects: ReadonlyMap<string, string>,
) {
  const { request } = command;
  const host = command.entries.find((entry) => entry.identity.id === command.ownerId);
  if (host?.identity.kind !== 'host' || !host.version)
    throw new Error('The host layout has not loaded');
  const destinations: PlannedWindow[] = [];
  const selected = new Map(command.slots.map((slot) => [slot.identity.id, slot]));
  const active = new Set([command.ownerId, ...selected.keys()]);
  for (const entry of command.entries) {
    if (!active.has(entry.identity.id)) continue;
    const mapping = selected.get(entry.identity.id);
    const slot = request.arrangement.windows.find((slot) => slot.key === mapping?.key);
    const base = entry.version?.content ?? { ...host.version.content, buffers: [], views: {} };
    const hostWindow = entry.identity.kind === 'host';
    const originalProject = /^\/project\/([0-9a-f]{10})/.exec(entry.route ?? '')?.[1];
    const snapshot =
      hostWindow && request.scope === 'project'
        ? projectWindowSnapshot(
            base.snapshot,
            slot,
            request.projectId!,
            sessionProjects,
            originalProject,
            request.layoutRef,
          )
        : savedWindowSnapshot(base.snapshot, slot, hostWindow ? request.layoutRef : undefined);
    const visibleProject =
      entry.identity.kind === 'host'
        ? request.scope === 'project'
          ? request.projectId
          : slot?.project_id
        : entry.identity.projectId;
    const dedicated = request.arrangement.windows.some(
      (window) => window.kind === 'project' && window.project_id === visibleProject,
    );
    const route =
      visibleProject && (!hostWindow || !dedicated) ? `/project/${visibleProject}` : '/';
    destinations.push({
      identity: entry.identity,
      content: { snapshot, buffers: [], views: base.views },
      route,
    });
  }
  retainArrangementDrafts(destinations, command, sessionProjects);
  for (const destination of destinations) {
    const sources = command.entries
      .filter((entry) => entry.version)
      .sort(
        (a, b) =>
          Number(a.identity.id === destination.identity.id) -
          Number(b.identity.id === destination.identity.id),
      )
      .map((entry) => entry.version!.content);
    destination.content.views = arrangementViews(destination.content, sources);
  }
  return desktopArrangementPlanSchema.parse({
    changes: command.entries.map((entry) => {
      const destination = destinations.find((window) => window.identity.id === entry.identity.id);
      return destination
        ? { id: entry.identity.id, content: destination.content, route: destination.route }
        : {
            id: entry.identity.id,
            content: { snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} },
            route: entry.route ?? '/',
          };
    }),
  });
}
