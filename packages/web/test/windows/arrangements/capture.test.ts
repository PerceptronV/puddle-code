import { expect, it } from 'vitest';
import { UNTITLED_SESSION, uiStateSnapshotSchema, type TabRef } from '@puddle/shared';
import {
  captureWindowArrangement,
  type ArrangementSource,
} from '../../../src/features/windows/arrangements/capture';
import {
  allLeaves,
  flattenTabs,
  makeLeaf,
} from '../../../src/features/workspace/layout/layout-tree';

const profile = 'aaaaaaaaaa';
const project = '1111111111';
const other = '2222222222';
const session = '00000000-0000-4000-8000-000000000001';
const otherSession = '00000000-0000-4000-8000-000000000002';
const sessions = new Map([
  [session, project],
  [otherSession, other],
]);
const terminal: TabRef = { type: 'terminal', session };
const foreign: TabRef = { type: 'terminal', session: otherSession };
const editor: TabRef = { type: 'editor', tab: { session, path: 'a.ts' } };
const snapshot = (tabs: TabRef[]) =>
  uiStateSnapshotSchema.parse({ layout_mode: 'profile', layout_tree: makeLeaf(tabs) });
const host = (tabs: TabRef[]): ArrangementSource => ({
  identity: { kind: 'host', id: 'host-native' },
  snapshot: snapshot(tabs),
  visibleProject: project,
});
const pane = (id: string, anchor: string, tabs: TabRef[]): ArrangementSource => ({
  identity: { kind: 'pane', id, profileId: profile, projectId: anchor },
  snapshot: snapshot(tabs),
  visibleProject: anchor,
});

it('captures an anchored mixed-project pane intact while partitioning the profile-wide host', () => {
  const sources = [
    host([terminal, foreign]),
    pane('mixed', project, [editor, foreign]),
    pane('unrelated', other, [foreign]),
  ];
  const before = structuredClone(sources);
  const saved = captureWindowArrangement(sources, 'project', project, sessions);
  expect(saved.window_arrangement.windows.map((window) => window.key)).toEqual(['host', 'mixed']);
  const [home, detached] = saved.window_arrangement.windows;
  expect(home?.layout_tree).toBeNull();
  expect(Object.keys(home!.project_layouts)).toEqual([project]);
  expect(flattenTabs(home!.project_layouts[project]!.layout_tree!)).toEqual([terminal]);
  expect(flattenTabs(detached!.layout_tree!)).toEqual([editor, foreign]);
  expect(flattenTabs(saved.layout_tree!)).toEqual([terminal, editor, foreign]);
  expect(sources).toEqual(before);
});

it('retains a project-mode host slice intact, with no other project slices in a project save', () => {
  const source = host([]);
  source.snapshot.layout_mode = 'project';
  source.snapshot.project_layouts = {
    [project]: {
      layout_tree: makeLeaf([terminal, foreign]),
      active_session: session,
      layout_ref: 5,
    },
    [other]: { layout_tree: makeLeaf([editor]), active_session: null, layout_ref: 6 },
  };
  const saved = captureWindowArrangement([source], 'project', project, sessions);
  expect(flattenTabs(saved.layout_tree!)).toEqual([terminal, foreign]);
  expect(saved.active_session).toBe(session);
  expect(saved.window_arrangement.windows[0]!.project_layouts[project]).not.toHaveProperty(
    'layout_ref',
  );
});

it('builds a browser fallback with independent editor views, unique pane ids and one terminal viewer', () => {
  const source = host([terminal, editor]);
  const detached = pane('pane', project, [terminal, editor]);
  detached.snapshot.layout_tree!.id = source.snapshot.layout_tree!.id;
  const saved = captureWindowArrangement([source, detached], 'profile', null, sessions);
  expect(flattenTabs(saved.layout_tree!).filter((tab) => tab.type === 'editor')).toHaveLength(2);
  expect(flattenTabs(saved.layout_tree!).filter((tab) => tab.type === 'terminal')).toHaveLength(1);
  const ids = allLeaves(saved.layout_tree!).map((leaf) => leaf.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(saved.window_arrangement.windows).toHaveLength(2);
});

it('omits draft text, view caches and shell chrome, and preserves legacy flat tabs', () => {
  const source = host([]);
  source.snapshot = uiStateSnapshotSchema.parse({
    layout_tree: null,
    session_tabs: [session],
    sidebar_collapsed: true,
    layout_ref: 9,
    buffers: [{ content: 'private draft' }],
    views: { cursor: 'private position' },
  });
  const saved = captureWindowArrangement([source], 'profile', null, sessions);
  expect(flattenTabs(saved.layout_tree!)).toEqual([terminal]);
  const encoded = JSON.stringify(saved.window_arrangement);
  expect(encoded).not.toMatch(/private|sidebar|layout_ref|buffers|views/);
});

it('does not assign dashboard untitled drafts to an arbitrary project save', () => {
  const untitled: TabRef = {
    type: 'editor',
    tab: { kind: 'untitled', session: UNTITLED_SESSION, path: 'idea' },
  };
  const source = host([terminal, untitled]);
  source.visibleProject = null;
  const saved = captureWindowArrangement([source], 'project', project, sessions);
  expect(flattenTabs(saved.layout_tree!)).toEqual([terminal]);
  expect(flattenTabs(source.snapshot.layout_tree!)).toEqual([terminal, untitled]);
});

it('captures a project-only window set using a stable logical slot and no host prerequisite', () => {
  const source: ArrangementSource = {
    identity: { kind: 'project', id: 'native-instance', profileId: profile, projectId: project },
    snapshot: snapshot([editor, foreign]),
    visibleProject: project,
  };
  const saved = captureWindowArrangement([source], 'project', project, sessions);
  expect(saved.window_arrangement.windows.map((window) => [window.key, window.kind])).toEqual([
    [`project-${project}`, 'project'],
  ]);
  expect(flattenTabs(saved.layout_tree!)).toEqual([editor, foreign]);
});
