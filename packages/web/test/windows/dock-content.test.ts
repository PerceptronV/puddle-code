import { expect, it } from 'vitest';
import { uiStateSnapshotSchema, type DesktopWorkspaceContent, type TabRef } from '@puddle/shared';
import {
  allLeaves,
  flattenTabs,
  hasDuplicateIds,
  makeLeaf,
  tabRefKey,
} from '../../src/features/workspace/layout/layout-tree';
import { detachPaneContent, detachTabContent } from '../../src/features/windows/transfer-content';
import { dockPaneContent } from '../../src/features/windows/dock-content';
import { transferPaneViews } from '../../src/features/windows/transfer-views';

const project = '1234567890';
const otherProject = 'abcdef1234';
const session = '00000000-0000-4000-8000-000000000001';
const editor = (path: string): TabRef => ({ type: 'editor', tab: { session, path } });
const terminal: TabRef = { type: 'terminal', session };
const draft = (path: string, content = path) => ({ session, path, content, baseMtimeMs: 1 });
function content(tabs: TabRef[], id = 'pane'): DesktopWorkspaceContent {
  return {
    snapshot: uiStateSnapshotSchema.parse({
      layout_mode: 'profile',
      layout_tree: { ...makeLeaf(tabs), id },
    }),
    buffers: [],
    views: {},
  };
}
function viewKey(pane: string, scope = 'profile', namespace = 'code') {
  return `${namespace}:transport-scope:${JSON.stringify([
    JSON.stringify([`profile-id:${scope}`, pane, tabRefKey(editor('move.ts'))]),
    'code',
    [session, null, 'move.ts'],
  ])}`;
}

it('docks beside an existing pane, retaining duplicate editor views and rekeying their positions', () => {
  const destination = content([editor('move.ts'), editor('stay.ts')]);
  const incoming = content([editor('move.ts'), terminal]);
  const pane = incoming.snapshot.layout_tree!;
  if (pane.kind === 'leaf') pane.previewKey = tabRefKey(editor('move.ts'));
  destination.buffers = [draft('move.ts'), draft('stay.ts'), draft('orphan.ts')];
  incoming.buffers = [draft('move.ts')];
  destination.views = { [viewKey('pane')]: { line: 3 } };
  incoming.views = { [viewKey('pane')]: { line: 27 } };
  const originals = structuredClone([destination, incoming]);
  const merged = dockPaneContent(destination, incoming, project);
  const tree = merged.snapshot.layout_tree!;
  expect(hasDuplicateIds(tree)).toBe(false);
  const [kept, moved] = allLeaves(tree);
  expect(kept).toEqual(destination.snapshot.layout_tree);
  expect(moved!.id).not.toBe('pane');
  expect(moved!.tabs).toEqual([editor('move.ts'), terminal]);
  expect(moved!.previewKey).toBe(tabRefKey(editor('move.ts')));
  expect(merged.buffers).toEqual(destination.buffers);
  expect(merged.views).toEqual({
    [viewKey('pane')]: { line: 3 },
    [viewKey(moved!.id)]: { line: 27 },
  });
  expect([destination, incoming]).toEqual(originals);
});

it('rejects different dirty text or saved baselines before changing either window', () => {
  const destination = content([editor('move.ts')]);
  destination.buffers = [draft('move.ts', 'destination edits')];
  const incoming = content([editor('move.ts')]);
  incoming.buffers = [draft('move.ts', 'incoming edits')];
  const before = structuredClone([destination, incoming]);
  expect(() => dockPaneContent(destination, incoming, project)).toThrow('different unsaved edits');
  expect([destination, incoming]).toEqual(before);
  incoming.buffers = [{ ...destination.buffers[0]!, baseMtimeMs: 2 }];
  expect(() => dockPaneContent(destination, incoming, project)).toThrow('different unsaved edits');
});

it('preserves source/preview order and terminal identity while moving an existing terminal view', () => {
  const destination = content([editor('stay.ts'), terminal], 'existing');
  const incoming = content([terminal, editor('move.ts')], 'incoming');
  incoming.snapshot.active_session = session;
  const merged = dockPaneContent(destination, incoming, project, {
    paneId: 'existing',
    edge: 'left',
  });
  expect(allLeaves(merged.snapshot.layout_tree!).map((leaf) => leaf.tabs)).toEqual([
    [terminal, editor('move.ts')],
    [editor('stay.ts')],
  ]);
  expect(merged.snapshot.active_session).toBe(session);
});

it('keeps project slices, inactive history and sidebar settings while moving parked terminal views once', () => {
  const destination = content([editor('historical.ts')], 'historical');
  const live = makeLeaf([editor('stay.ts')]);
  const parked = makeLeaf([terminal, editor('other.ts')]);
  destination.snapshot = {
    ...destination.snapshot,
    layout_mode: 'project',
    sidebar_collapsed: true,
    project_layouts: {
      [project]: { layout_tree: live, active_session: null, layout_ref: 42 },
      [otherProject]: { layout_tree: parked, active_session: session, layout_ref: null },
    },
  };
  const incoming = content([terminal, editor('move.ts')], parked.id);
  incoming.views = { [viewKey(parked.id)]: { scrollTop: 32 } };
  const merged = dockPaneContent(destination, incoming, project);
  const moved = allLeaves(merged.snapshot.project_layouts[project]!.layout_tree!).at(-1)!;
  expect(moved.id).not.toBe(parked.id);
  expect(merged.snapshot.layout_mode).toBe('project');
  expect(merged.snapshot.layout_tree).toEqual(destination.snapshot.layout_tree);
  expect(merged.snapshot.sidebar_collapsed).toBe(true);
  expect(merged.snapshot.project_layouts[project]!.layout_ref).toBe(42);
  expect(flattenTabs(merged.snapshot.project_layouts[otherProject]!.layout_tree!)).toEqual([
    editor('other.ts'),
  ]);
  expect(merged.snapshot.project_layouts[otherProject]!.active_session).toBeNull();
  expect(merged.views[viewKey(moved.id, `project:${project}`)]).toEqual({ scrollTop: 32 });
});

it('recovers a legacy destination tree and rejects stale drop targets without losing it', () => {
  const destination = content([]);
  destination.snapshot.layout_tree = null;
  destination.snapshot.editor_tabs = [{ session, path: 'legacy.ts' }];
  const incoming = content([editor('move.ts')], 'incoming');
  expect(
    flattenTabs(dockPaneContent(destination, incoming, project).snapshot.layout_tree!),
  ).toEqual([editor('legacy.ts'), editor('move.ts')]);
  expect(() =>
    dockPaneContent(destination, incoming, project, { paneId: 'gone', edge: 'right' }),
  ).toThrow('destination pane has changed');
});

it('translates detached project views into pane scope and back with the source cursor retained', () => {
  const source = content([editor('move.ts')]);
  source.snapshot.layout_mode = 'project';
  source.snapshot.project_layouts[project] = {
    layout_tree: source.snapshot.layout_tree,
    active_session: null,
    layout_ref: null,
  };
  source.views = { [viewKey('pane', `project:${project}`)]: { cursor: 19 } };
  for (const detached of [
    detachPaneContent(source, project, 'pane'),
    detachTabContent(source, project, editor('move.ts'), 'pane'),
  ]) {
    expect(detached.destination.views[viewKey('pane')]).toEqual({ cursor: 19 });
    expect(detached.source.views).toEqual(source.views);
    const returned = dockPaneContent(detached.source, detached.destination, project);
    const moved = allLeaves(returned.snapshot.project_layouts[project]!.layout_tree!).at(-1)!;
    expect(returned.views[viewKey(moved.id, `project:${project}`)]).toEqual({ cursor: 19 });
  }
});

it('does not rewrite unrelated panes, scopes, malformed keys or target data that contains pane ids', () => {
  const state = { zoom: 1.5 };
  const views = {
    [viewKey('selected', `project:${project}`, 'pdf-zoom')]: state,
    [viewKey('other', `project:${project}`)]: {},
    [viewKey('selected', `project:${otherProject}`)]: {},
    'unknown:[malformed': {},
    'opaque-adapter': {},
  };
  expect(
    transferPaneViews(views, new Map([['selected', 'new-pane']]), `project:${project}`, 'profile'),
  ).toEqual({
    [viewKey('new-pane', 'profile', 'pdf-zoom')]: state,
  });
});
