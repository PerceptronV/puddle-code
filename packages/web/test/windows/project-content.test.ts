import { expect, it } from 'vitest';
import {
  UNTITLED_SESSION,
  uiStateSnapshotSchema,
  type DesktopWorkspaceContent,
  type LayoutNode,
  type TabRef,
} from '@puddle/shared';
import {
  allLeaves,
  flattenTabs,
  makeLeaf,
  tabRefKey,
} from '../../src/features/workspace/layout/layout-tree';
import {
  detachProjectContent,
  returnProjectContent,
} from '../../src/features/windows/project-content';

const project = '1234567890';
const otherProject = 'abcdef1234';
const session = '00000000-0000-4000-8000-000000000001';
const otherSession = '00000000-0000-4000-8000-000000000002';
const unknownSession = '00000000-0000-4000-8000-000000000003';
const sessions = new Map([
  [session, project],
  [otherSession, otherProject],
]);
const file = (path: string, owner = session): TabRef => ({
  type: 'editor',
  tab: { session: owner, path },
});
const terminal: TabRef = { type: 'terminal', session };
const draft = (path: string, owner = session) => ({
  session: owner,
  path,
  content: `dirty ${path}`,
  baseMtimeMs: 1,
});
const split = (children: LayoutNode[], sizes: number[]): LayoutNode => ({
  kind: 'split',
  id: crypto.randomUUID(),
  direction: 'col',
  children,
  sizes,
});
const content = (
  patch: Partial<DesktopWorkspaceContent['snapshot']> = {},
  buffers: DesktopWorkspaceContent['buffers'] = [],
): DesktopWorkspaceContent => ({
  snapshot: uiStateSnapshotSchema.parse({ layout_mode: 'profile', ...patch }),
  buffers,
  views: {},
});

it('detaches the complete project tree, retaining its mixed tabs and independent source duplicates', () => {
  const pane = makeLeaf([terminal, file('mixed.ts', otherSession)]);
  pane.previewKey = tabRefKey(file('mixed.ts', otherSession));
  const tree = split([pane, makeLeaf([file('owned.ts')])], [30, 70]);
  const other = makeLeaf([file('mixed.ts', otherSession)]);
  const input = content(
    {
      layout_mode: 'project',
      project_layouts: {
        [project]: { layout_tree: tree, active_session: session, layout_ref: null },
        [otherProject]: { layout_tree: other, active_session: null, layout_ref: null },
      },
    },
    [draft('owned.ts'), draft('mixed.ts', otherSession), draft('orphan.ts')],
  );
  const original = structuredClone(input);
  const result = detachProjectContent(input, project, sessions, project);
  expect(result.destination.snapshot.layout_tree).toEqual(tree);
  expect(result.destination.snapshot.active_session).toBe(session);
  expect(result.destination.snapshot.layout_mode).toBe('profile');
  expect(result.destination.snapshot.project_layouts).toEqual({});
  expect(flattenTabs(result.source.snapshot.project_layouts[project]!.layout_tree!)).toEqual([]);
  expect(result.source.snapshot.project_layouts[otherProject]).toEqual(
    input.snapshot.project_layouts[otherProject],
  );
  expect(result.destination.buffers).toEqual([draft('owned.ts'), draft('mixed.ts', otherSession)]);
  expect(result.source.buffers).toEqual([draft('mixed.ts', otherSession), draft('orphan.ts')]);
  expect(input).toEqual(original);
});

it('partitions profile-wide mixed panes by session ownership and retains unknown sessions', () => {
  const untitled = file('draft', UNTITLED_SESSION);
  const first = makeLeaf(
    [file('ours.ts'), file('theirs.ts', otherSession), untitled],
    tabRefKey(untitled),
  );
  first.previewKey = tabRefKey(file('ours.ts'));
  const second = makeLeaf([terminal, file('unknown.ts', unknownSession)]);
  const input = content(
    { layout_tree: split([first, second], [60, 40]), active_session: session },
    [draft('ours.ts'), draft('theirs.ts', otherSession), draft('draft', UNTITLED_SESSION)],
  );
  const result = detachProjectContent(input, project, sessions, project);
  expect(flattenTabs(result.destination.snapshot.layout_tree!)).toEqual([
    file('ours.ts'),
    untitled,
    terminal,
  ]);
  expect(flattenTabs(result.source.snapshot.layout_tree!)).toEqual([
    file('theirs.ts', otherSession),
    file('unknown.ts', unknownSession),
  ]);
  expect(result.source.snapshot.layout_mode).toBe('profile');
  expect(result.source.snapshot.active_session).toBeNull();
  expect(result.destination.snapshot.active_session).toBe(session);
  expect(allLeaves(result.destination.snapshot.layout_tree!)[0]!.previewKey).toBe(first.previewKey);
  expect(result.destination.buffers).toEqual([draft('ours.ts'), draft('draft', UNTITLED_SESSION)]);
  const fromOtherProject = detachProjectContent(input, project, sessions, otherProject);
  expect(flattenTabs(fromOtherProject.source.snapshot.layout_tree!)).toContainEqual(untitled);
});

it('returns the project tree, sidebar state and orphaned drafts without removing unrelated work', () => {
  const stay = makeLeaf([file('stay.ts', otherSession)]);
  const incomingTree = split([makeLeaf([file('first.ts')]), makeLeaf([terminal])], [30, 70]);
  const host = content(
    {
      layout_mode: 'project',
      project_layouts: {
        [otherProject]: { layout_tree: stay, active_session: null, layout_ref: null },
      },
    },
    [draft('stay.ts', otherSession)],
  );
  const incoming = content(
    { layout_tree: incomingTree, active_session: session, sidebar_collapsed: true },
    [draft('first.ts'), draft('recovery.ts')],
  );
  const result = returnProjectContent(host, incoming, project);
  expect(result.snapshot.project_layouts[otherProject]).toEqual(
    host.snapshot.project_layouts[otherProject],
  );
  expect(result.snapshot.sidebar_collapsed).toBe(true);
  const restored = result.snapshot.project_layouts[project]!;
  expect(restored.active_session).toBe(session);
  expect(flattenTabs(restored.layout_tree!)).toEqual([
    file('first.ts'),
    terminal,
    { type: 'editor', tab: { session, path: 'recovery.ts', kind: 'file', view: 'source' } },
  ]);
  expect(result.buffers).toHaveLength(3);
});

it('remaps colliding pane ids and their view positions while retaining duplicate editor views', () => {
  const pane = makeLeaf([file('shared.ts')]);
  const viewKey = (scope: string, id: string) =>
    'monaco:' +
    JSON.stringify([
      JSON.stringify([`profile:${scope}`, id, tabRefKey(file('shared.ts'))]),
      'source',
      'target',
    ]);
  const host = content({ layout_tree: pane });
  host.views[viewKey('profile', pane.id)] = { line: 1 };
  const incoming = content({ layout_tree: pane }, [draft('shared.ts')]);
  incoming.views[viewKey('profile', pane.id)] = { line: 30 };
  const result = returnProjectContent(host, incoming, project);
  const leaves = allLeaves(result.snapshot.layout_tree!);
  expect(leaves).toHaveLength(2);
  expect(leaves[0]!.id).toBe(pane.id);
  expect(leaves[1]!.id).not.toBe(pane.id);
  expect(result.views[viewKey('profile', leaves[0]!.id)]).toEqual({ line: 1 });
  expect(result.views[viewKey('profile', leaves[1]!.id)]).toEqual({ line: 30 });
  expect(flattenTabs(result.snapshot.layout_tree!)).toEqual([file('shared.ts'), file('shared.ts')]);
});

it('moves terminal viewers out of other slices and rejects conflicting dirty copies', () => {
  const host = content(
    {
      layout_mode: 'project',
      project_layouts: {
        [otherProject]: {
          layout_tree: makeLeaf([terminal, file('stay.ts', otherSession)]),
          active_session: session,
          layout_ref: null,
        },
      },
    },
    [draft('shared.ts')],
  );
  const incoming = content(
    { layout_tree: makeLeaf([terminal, file('shared.ts')]), active_session: session },
    [draft('shared.ts')],
  );
  const result = returnProjectContent(host, incoming, project);
  expect(flattenTabs(result.snapshot.project_layouts[otherProject]!.layout_tree!)).toEqual([
    file('stay.ts', otherSession),
  ]);
  expect(result.snapshot.project_layouts[otherProject]!.active_session).toBeNull();
  incoming.buffers[0]!.content = 'conflicting edit';
  const original = structuredClone(host);
  expect(() => returnProjectContent(host, incoming, project)).toThrow('different unsaved edits');
  expect(host).toEqual(original);
});
