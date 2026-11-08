import { expect, it } from 'vitest';
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
