import { expect, it } from 'vitest';
import {
  desktopPaneCloseReview,
  desktopPaneOrphanedBuffers,
  huddleDefinitionPath,
  huddleSourcePaths,
} from '@puddle/shared';
import { fileViewCount } from '../../src/features/workspace/tabs/close/file-views';
import { DesktopContentState } from '../../src/features/windows/state/content-state';
import { retainLateDrafts } from '../../src/features/windows/state/late-draft-recovery';
import { desktopTabKey, hasHuddleTabs, sessionTabRef, uiStateSnapshotSchema } from '@puddle/shared';
import {
  allLeaves,
  dropTab,
  flattenTabs,
  makeLeaf,
  makeSplit,
  tabRefKey,
} from '../../src/features/workspace/layout/layout-tree';
import {
  parkedTerminalSessions,
  splitToProjects,
} from '../../src/features/workspace/layout/project-layout';
import { detachTabContent } from '../../src/features/windows/transfers/content/transfer-content';
import { detachProjectContent } from '../../src/features/windows/transfers/content/project-content';
import { hasInactiveSavedSession } from '../../src/features/windows/navigation/session-restoration';
import { sessionLifecycle } from '../../src/features/workspace/sessions/lifecycle';

const id = '00000000-0000-4000-8000-000000000001';
const project = '1111111111';
const ref = sessionTabRef({ id, kind: 'huddle' });

it('transfers both huddle documents, including an absent layout draft, and reviews their last holders', () => {
  const [manifest, layout] = huddleSourcePaths('a'.repeat(32));
  const buffers = [
    { session: id, path: manifest, content: 'graph draft', baseMtimeMs: 1 },
    { session: id, path: layout, content: 'layout draft', baseMtimeMs: -1 },
  ];
  const leaf = makeLeaf([ref]);
  const snapshot = uiStateSnapshotSchema.parse({ layout_tree: leaf });
  const content = { snapshot, buffers, views: {} };
  expect(desktopPaneCloseReview(content)).toMatchObject({
    required: true,
    orphaned: 0,
    targets: [{ paneId: leaf.id, ref }],
  });
  expect(desktopPaneOrphanedBuffers(content)).toEqual([]);
  const moved = detachTabContent(content, project, ref, leaf.id);
  expect(moved.destination.buffers).toEqual(buffers);
  expect(moved.source.buffers).toEqual([]);
  const duplicate = uiStateSnapshotSchema.parse({
    layout_tree: makeSplit('row', [
      leaf,
      makeLeaf([{ type: 'editor', tab: { session: id, path: layout } }]),
    ]),
  });
  expect(fileViewCount(duplicate, buffers[0]!)).toBe(1);
  expect(fileViewCount(duplicate, buffers[1]!)).toBe(2);
  const shared = detachTabContent({ ...content, snapshot: duplicate }, project, ref, leaf.id);
  expect(shared.source.buffers).toEqual([buffers[1]]);
  expect(shared.destination.buffers).toEqual(buffers);
  const state = new DesktopContentState();
  for (const buffer of buffers) state.registerBuffer(buffer, () => buffer);
  expect(state.capture(snapshot).buffers).toEqual(buffers);
});

it('moves a graph manifest draft with its implicit huddle view, reviews it on close, and preserves duplicate source holders', () => {
  const buffer = {
    session: id,
    path: huddleDefinitionPath('a'.repeat(32)),
    content: 'unsaved graph',
    baseMtimeMs: 1,
  };
  const unrelated = { ...buffer, path: '.puddle/huddle/' + 'a'.repeat(32) + '/nodes/script.ts' };
  const leaf = makeLeaf([ref]);
  const snapshot = uiStateSnapshotSchema.parse({ layout_tree: leaf });
  const content = { snapshot, buffers: [buffer, unrelated], views: {} };
  expect(fileViewCount(snapshot, buffer)).toBe(1);
  expect(desktopPaneCloseReview(content).targets).toEqual([{ paneId: leaf.id, ref }]);
  expect(desktopPaneOrphanedBuffers(content)).toEqual([unrelated]);
  expect(retainLateDrafts(snapshot, [buffer])).toBe(snapshot);
  const moved = detachTabContent(content, project, ref, leaf.id);
  expect(moved.destination.buffers).toEqual([buffer]);
  expect(moved.source.buffers).toEqual([unrelated]);
  const duplicate = uiStateSnapshotSchema.parse({
    layout_tree: makeSplit('row', [leaf, makeLeaf([{ type: 'editor', tab: buffer }])]),
  });
  expect(fileViewCount(duplicate, buffer)).toBe(2);
  const copied = detachTabContent({ ...content, snapshot: duplicate }, project, ref, leaf.id);
  expect(copied.source.buffers).toContainEqual(buffer);
  expect(copied.destination.buffers).toEqual([buffer]);
  const state = new DesktopContentState();
  state.registerBuffer(buffer, () => buffer);
  expect(state.capture(snapshot).buffers).toEqual([buffer]);
});

it('gives a huddle a distinct tab identity and never parks it as a terminal', () => {
  expect(ref).toEqual({ type: 'huddle', session: id });
  expect(tabRefKey(ref)).toBe(`huddle:${id}`);
  expect(desktopTabKey(ref)).not.toBe(desktopTabKey({ type: 'terminal', session: id }));
  const snapshot = uiStateSnapshotSchema.parse({
    layout_tree: makeLeaf([ref]),
    active_session: id,
  });
  const split = splitToProjects(snapshot, [project], new Map([[id, project]]), project);
  expect(hasHuddleTabs(uiStateSnapshotSchema.parse(split))).toBe(true);
  expect(parkedTerminalSessions(split.project_layouts!, '2222222222')).toEqual([]);
  expect(sessionLifecycle({ kind: 'huddle', status: 'exited' }).resumable).toBe(false);
  expect(sessionLifecycle({ kind: 'huddle', status: 'running' }).live).toBe(true);
});

it('allows two huddle views without moving the first view or changing placement identity', () => {
  const first = makeLeaf([ref]);
  const second = makeLeaf();
  const tree = dropTab(makeSplit('row', [first, second]), {
    ref,
    fromLeafId: first.id,
    toLeafId: second.id,
    edge: 'center',
    copy: true,
  });
  expect(flattenTabs(tree)).toEqual([ref, ref]);
  expect(allLeaves(tree)).toHaveLength(2);
});

it('moves a huddle pane/tab/project with its active binding and leaves source files alone', () => {
  const file = {
    type: 'editor' as const,
    tab: { session: id, path: '.puddle/huddle/id/huddle.json' },
  };
  const leaf = makeLeaf([ref, file], tabRefKey(ref));
  const snapshot = uiStateSnapshotSchema.parse({ layout_tree: leaf, active_session: id });
  const content = {
    snapshot,
    buffers: [{ ...file.tab, content: 'unsaved source', baseMtimeMs: 1 }],
    views: {},
  };
  const detached = detachTabContent(content, project, ref, leaf.id);
  expect(detached.destination.snapshot.active_session).toBe(id);
  expect(flattenTabs(detached.destination.snapshot.layout_tree!)).toEqual([ref]);
  expect(detached.source.buffers).toEqual(content.buffers);
  expect(detached.destination.buffers).toEqual([]);
  const moved = detachProjectContent(content, project, new Map([[id, project]]), project);
  expect(moved.destination.snapshot.active_session).toBe(id);
  expect(moved.source.snapshot.active_session).toBeNull();
  expect(moved.destination.buffers).toEqual(content.buffers);
  expect(
    hasInactiveSavedSession(
      { ...snapshot, layout_tree: { ...leaf, activeKey: tabRefKey(file) } },
      id,
    ),
  ).toBe(true);
});
