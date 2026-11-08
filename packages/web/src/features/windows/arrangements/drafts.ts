import type {
  DesktopArrangementPlanCommand,
  DesktopBufferSnapshot,
  DesktopWorkspaceContent,
} from '@puddle/shared';
import { flattenTabs } from '../../workspace/layout/layout-tree';
import { retainLateDrafts } from '../state/late-draft-recovery';
import { windowBufferKey } from '../state/content-state';
import { arrangementTrees } from './content';

export interface PlannedWindow {
  identity: DesktopArrangementPlanCommand['entries'][number]['identity'];
  content: DesktopWorkspaceContent;
  route: string;
}
const same = (a: DesktopBufferSnapshot, b: DesktopBufferSnapshot) =>
  a.content === b.content && a.baseMtimeMs === b.baseMtimeMs;
const projectInRoute = (route?: string) => /^\/project\/([0-9a-f]{10})/.exec(route ?? '')?.[1];

/** Reuse existing drafts; an arrangement never resolves two independent edits by choosing one. */
export function retainArrangementDrafts(
  destinations: PlannedWindow[],
  command: DesktopArrangementPlanCommand,
  sessionProjects: ReadonlyMap<string, string>,
): void {
  const all = command.entries.flatMap((entry) =>
    (entry.version?.content.buffers ?? []).map((buffer) => ({ entry, buffer })),
  );
  const variants = new Map<string, DesktopBufferSnapshot[]>();
  for (const { buffer } of all) {
    const key = windowBufferKey(buffer);
    const values = variants.get(key) ?? [];
    if (!values.some((value) => same(value, buffer))) values.push(buffer);
    variants.set(key, values);
  }
  const referenced = new Map(
    destinations.map((window) => [
      window.identity.id,
      new Set(
        arrangementTrees(window.content.snapshot)
          .flatMap(({ tree }) => (tree ? flattenTabs(tree) : []))
          .flatMap((ref) => (ref.type === 'editor' ? [windowBufferKey(ref.tab)] : [])),
      ),
    ]),
  );
  for (const destination of destinations) {
    const original = command.entries.find((entry) => entry.identity.id === destination.identity.id);
    for (const key of referenced.get(destination.identity.id)!) {
      const values = variants.get(key);
      if (!values?.length) continue;
      const own = original?.version?.content.buffers.find(
        (buffer) => windowBufferKey(buffer) === key,
      );
      if (!own && values.length > 1)
        throw new Error(
          `Windows have different unsaved edits to ${values[0]!.path}; keep their separate windows or resolve those edits first`,
        );
      destination.content.buffers.push(own ?? values[0]!);
    }
  }
  for (const { entry, buffer } of all) {
    const key = windowBufferKey(buffer);
    if (
      destinations.some((window) =>
        window.content.buffers.some(
          (value) => windowBufferKey(value) === key && same(value, buffer),
        ),
      )
    )
      continue;
    const home =
      command.request.scope === 'project' && entry.identity.kind !== 'host'
        ? command.request.projectId
        : (sessionProjects.get(buffer.session) ??
          (entry.identity.kind === 'host'
            ? projectInRoute(entry.route)
            : entry.identity.projectId));
    const own = destinations.find((window) => window.identity.id === entry.identity.id);
    if (
      command.request.scope === 'project' &&
      entry.identity.kind === 'host' &&
      home !== command.request.projectId &&
      own
    ) {
      // Unrelated orphan drafts were already retained by this host. A selected
      // project load must not add recovery tabs to another project's slice.
      own.content.buffers.push(buffer);
      continue;
    }
    const projectOwner = destinations.find(
      (window) => window.identity.kind === 'project' && window.identity.projectId === home,
    );
    const destination =
      (own?.identity.kind === 'host' ? (projectOwner ?? own) : own) ??
      projectOwner ??
      destinations.find((window) => window.identity.kind === 'host')!;
    const conflict = destination.content.buffers.find((value) => windowBufferKey(value) === key);
    if (conflict && !same(conflict, buffer))
      throw new Error(`Both windows have different unsaved edits to ${buffer.path}`);
    if (!conflict) destination.content.buffers.push(buffer);
    let project =
      destination.identity.kind === 'host'
        ? (home ?? projectInRoute(destination.route))
        : destination.identity.projectId;
    if (destination.content.snapshot.layout_mode === 'project') {
      project ??= Object.keys(destination.content.snapshot.project_layouts)[0];
      if (!project)
        throw new Error('Open a project before recovering these unsaved files into its layout');
    }
    destination.content.snapshot = retainLateDrafts(
      destination.content.snapshot,
      [buffer],
      project,
    );
    // Bring an orphaned recovery draft into view, instead of silently parking it
    // behind the dashboard when its old native window is about to close.
    if (destination.identity.kind === 'host' && project && destination.route === '/')
      destination.route = `/project/${project}`;
  }
}
