import {
  windowArrangementSchema,
  type DesktopArrangementCapture,
  type LayoutScope,
  type SavedLayout,
  type WindowArrangement,
} from '@puddle/shared';
import { layoutSignature } from '../../workspace/layout/layout-signature';
import { returnProjectContent } from '../transfers/content/project-content';
import { captureWindowArrangement, type ArrangementSource } from './capture';

/** Closed project windows belong to the host's logical content, not its open window set. */
export function captureCatalogueLayout(
  capture: DesktopArrangementCapture,
  scope: LayoutScope,
  projectId: string | null,
  sessions: ReadonlyMap<string, string>,
) {
  const sources: ArrangementSource[] = capture.entries
    .filter((entry) => entry.open)
    .map((entry) => ({
      identity: entry.identity,
      snapshot: entry.snapshot,
      visibleProject: /^\/project\/([0-9a-f]{10})/.exec(entry.route ?? '')?.[1] ?? null,
    }));
  const host = sources.find((source) => source.identity.kind === 'host');
  for (const entry of capture.entries) {
    if (!entry.returnedProject || entry.open || entry.identity.kind !== 'project') continue;
    if (!host) throw new Error('The host layout has not loaded');
    if (!entry.snapshot.layout_tree) continue;
    const before = host.snapshot;
    host.snapshot = returnProjectContent(
      { snapshot: before, buffers: [], views: {} },
      { snapshot: entry.snapshot, buffers: [], views: {} },
      entry.identity.projectId,
    ).snapshot;
    // A project save cannot change the ownership of another project's mixed slice.
    if (scope === 'project' && before.layout_mode === 'project')
      host.snapshot = {
        ...host.snapshot,
        project_layouts: {
          ...before.project_layouts,
          [entry.identity.projectId]: host.snapshot.project_layouts[entry.identity.projectId]!,
        },
      };
  }
  return captureWindowArrangement(sources, scope, projectId, sessions);
}

/** Native ids, window ordering and transient focus do not make a named layout dirty. */
export function arrangementSignature(arrangement: WindowArrangement): string {
  return JSON.stringify(
    arrangement.windows
      .map((window) =>
        JSON.stringify({
          kind: window.kind,
          // Host navigation is transient; detached ownership is structural.
          project: window.kind === 'host' ? null : window.project_id,
          mode: window.layout_mode,
          tree: layoutSignature(window.layout_tree),
          slices: Object.entries(window.project_layouts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, slice]) => [id, layoutSignature(slice.layout_tree)]),
        }),
      )
      .sort(),
  );
}

/** Legacy native loads consolidate their scope into one host presentation. */
export function catalogueArrangement(saved: SavedLayout): WindowArrangement {
  if (saved.window_arrangement) return saved.window_arrangement;
  const slice = { layout_tree: saved.layout_tree, active_session: saved.active_session };
  return windowArrangementSchema.parse({
    version: 1,
    windows: [
      {
        key: 'host',
        kind: 'host',
        project_id: saved.project_id,
        layout_mode: saved.scope === 'project' ? 'project' : 'profile',
        ...(saved.scope === 'project' ? { layout_tree: null, active_session: null } : slice),
        project_layouts: saved.scope === 'project' ? { [saved.project_id!]: slice } : {},
      },
    ],
  });
}
