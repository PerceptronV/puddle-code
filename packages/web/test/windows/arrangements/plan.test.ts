import { expect, it } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopArrangementPlanCommand,
  type DesktopWorkspaceContent,
  type TabRef,
} from '@puddle/shared';
import {
  makeLeaf,
  makeSplit,
  flattenTabs,
  tabRefKey,
} from '../../../src/features/workspace/layout/layout-tree';
import { planWindowArrangement } from '../../../src/features/windows/arrangements/plan';

const profileId = 'aaaaaaaaaa';
const project = '1111111111';
const other = '2222222222';
const session = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const sessions = new Map([
  [session, project],
  [second, other],
]);
const ref = (path: string, owner = session): TabRef => ({
  type: 'editor',
  tab: { session: owner, path },
});
const draft = (path: string, content = 'dirty') => ({ session, path, content, baseMtimeMs: 1 });
function content(tabs: TabRef[] = []): DesktopWorkspaceContent {
  return {
    snapshot: uiStateSnapshotSchema.parse({ layout_mode: 'profile', layout_tree: makeLeaf(tabs) }),
    buffers: [],
    views: {},
  };
}
function fixture(): DesktopArrangementPlanCommand {
  const host = { kind: 'host' as const, id: 'host' };
  const pane = { kind: 'pane' as const, id: 'pane', profileId, projectId: project };
  return {
    kind: 'plan-layout',
    ownerId: 'host',
    request: {
      id: 'arrangement',
      profileId,
      scope: 'profile',
      layoutRef: 7,
      arrangement: {
        version: 1,
        windows: [
          {
            key: 'host',
            kind: 'host',
            project_id: project,
            layout_mode: 'profile',
            layout_tree: makeLeaf(),
            active_session: null,
            project_layouts: {},
          },
          {
            key: 'pane-slot',
            kind: 'pane',
            project_id: project,
            layout_mode: 'profile',
            layout_tree: makeLeaf([ref('file.ts')]),
            active_session: null,
            project_layouts: {},
          },
        ],
      },
    },
    entries: [
      {
        identity: host,
        route: `/project/${project}`,
        open: true,
        returnedProject: false,
        version: { revision: 2, content: content([ref('file.ts')]) },
      },
      {
        identity: pane,
        route: `/project/${project}`,
        open: false,
        returnedProject: false,
        version: null,
      },
    ],
    slots: [
      { key: 'host', identity: host },
      { key: 'pane-slot', identity: pane },
    ],
  };
}

it('opens a project layout loaded from the dashboard in the host when it has no dedicated owner', () => {
  const command = fixture();
  command.entries[0]!.route = '/';
  command.request.scope = 'project';
  command.request.projectId = project;
  const host = command.request.arrangement.windows[0]!;
  host.layout_mode = 'project';
  host.layout_tree = null;
  host.project_layouts = {
    [project]: { layout_tree: makeLeaf([ref('file.ts')]), active_session: null },
  };
  const plan = planWindowArrangement(command, sessions);
  expect(plan.changes.find((change) => change.id === 'host')!.route).toBe(`/project/${project}`);
});

it('moves dirty content into a saved destination, preserves live chrome and does not mutate captures', () => {
  const command = fixture();
  command.entries[0]!.version!.content.buffers = [draft('file.ts')];
  command.entries[0]!.version!.content.snapshot.sidebar_collapsed = true;
  const before = structuredClone(command);
  const plan = planWindowArrangement(command, sessions);
  expect(command).toEqual(before);
  expect(plan.changes.find((window) => window.id === 'host')!.content.buffers).toEqual([]);
  const pane = plan.changes.find((window) => window.id === 'pane')!;
  expect(pane.content.buffers).toEqual([draft('file.ts')]);
  expect(pane.content.snapshot.sidebar_collapsed).toBe(true);
  expect(pane.route).toBe(`/project/${project}`);
  expect(plan.changes[0]!.content.snapshot.layout_ref).toBe(7);
});

it('keeps unsaved files omitted by the saved layout visible without collapsing independent editor views', () => {
  const command = fixture();
  command.request.arrangement.windows = [command.request.arrangement.windows[0]!];
  command.slots = [command.slots[0]!];
  command.request.arrangement.windows[0]!.layout_tree = makeSplit('row', [
    makeLeaf([ref('same.ts')]),
    makeLeaf([ref('same.ts')]),
  ]);
  command.entries[1]!.version = {
    revision: 1,
    content: { ...content([ref('omitted.ts')]), buffers: [draft('omitted.ts')] },
  };
  command.entries[1]!.open = true;
  const plan = planWindowArrangement(command, sessions);
  const host = plan.changes[0]!.content;
  expect(
    flattenTabs(host.snapshot.layout_tree!).map((tab) => tab.type === 'editor' && tab.tab.path),
  ).toEqual(['same.ts', 'same.ts', 'omitted.ts']);
  expect(host.buffers).toEqual([draft('omitted.ts')]);
  expect(plan.changes[1]!.content.buffers).toEqual([]);
});

it('replaces only a selected project slice and keeps mixed-project detached panes intact', () => {
  const command = fixture();
  command.request.scope = 'project';
  command.request.projectId = project;
  const host = command.entries[0]!.version!.content;
  const untouched = {
    layout_tree: makeLeaf([ref('other.ts', second)]),
    active_session: null,
    layout_ref: 5,
  };
  host.snapshot = {
    ...host.snapshot,
    layout_mode: 'project',
    project_layouts: {
      [project]: { layout_tree: makeLeaf([ref('old.ts')]), active_session: null, layout_ref: 1 },
      [other]: untouched,
    },
  };
  const slot = command.request.arrangement.windows[0]!;
  Object.assign(slot, {
    layout_mode: 'project',
    layout_tree: null,
    project_layouts: {
      [project]: { layout_tree: makeLeaf([ref('new.ts')]), active_session: null },
    },
  });
  command.request.arrangement.windows[1]!.layout_tree = makeLeaf([
    ref('mixed.ts', second),
    ref('file.ts'),
  ]);
  const plan = planWindowArrangement(command, sessions);
  expect(plan.changes[0]!.content.snapshot.project_layouts[other]).toEqual(untouched);
  expect(
    flattenTabs(plan.changes[0]!.content.snapshot.project_layouts[project]!.layout_tree!),
  ).toEqual([ref('new.ts')]);
  expect(flattenTabs(plan.changes[1]!.content.snapshot.layout_tree!)).toEqual([
    ref('mixed.ts', second),
    ref('file.ts'),
  ]);
});

it('partitions a profile-mode host without switching its mode or altering unrelated historical slices', () => {
  const command = fixture();
  command.request.scope = 'project';
  command.request.projectId = project;
  command.entries[0]!.version!.content = content([ref('selected.ts'), ref('unrelated.ts', second)]);
  const history = {
    layout_tree: makeLeaf([ref('history.ts', second)]),
    active_session: null,
    layout_ref: 9,
  };
  command.entries[0]!.version!.content.snapshot.project_layouts[other] = history;
  Object.assign(command.request.arrangement.windows[0]!, {
    layout_mode: 'project',
    layout_tree: null,
    project_layouts: {
      [project]: { layout_tree: makeLeaf([ref('loaded.ts')]), active_session: null },
    },
  });
  const result = planWindowArrangement(command, sessions).changes[0]!.content.snapshot;
  expect(result.layout_mode).toBe('profile');
  expect(result.project_layouts[other]).toEqual(history);
  expect(flattenTabs(result.layout_tree!)).toEqual([ref('unrelated.ts', second), ref('loaded.ts')]);
});

it('refuses to silently choose between divergent dirty copies for a new window', () => {
  const command = fixture();
  command.entries[0]!.version!.content.buffers = [draft('file.ts', 'first')];
  command.entries.push({
    ...command.entries[0]!,
    identity: { kind: 'pane', id: 'retiring', profileId, projectId: project },
    version: {
      revision: 1,
      content: { ...content([ref('file.ts')]), buffers: [draft('file.ts', 'second')] },
    },
  });
  const before = structuredClone(command);
  expect(() => planWindowArrangement(command, sessions)).toThrow('different unsaved edits');
  expect(command).toEqual(before);
});

it('retains divergent dirty copies when their independent native windows survive', () => {
  const command = fixture();
  command.request.arrangement.windows[0]!.layout_tree = makeLeaf([ref('file.ts')]);
  command.entries[0]!.version!.content.buffers = [draft('file.ts', 'first')];
  command.entries[1]!.open = true;
  command.entries[1]!.version = {
    revision: 1,
    content: { ...content([ref('file.ts')]), buffers: [draft('file.ts', 'second')] },
  };
  const result = planWindowArrangement(command, sessions);
  expect(result.changes.map((change) => change.content.buffers[0]!.content)).toEqual([
    'first',
    'second',
  ]);
});

it('consumes returned-project drafts without needing a live source renderer', () => {
  const command = fixture();
  command.entries.push({
    identity: { kind: 'project', id: 'returned', profileId, projectId: project },
    route: `/project/${project}`,
    open: false,
    returnedProject: true,
    version: {
      revision: 8,
      content: { ...content([ref('file.ts')]), buffers: [draft('file.ts')] },
    },
  });
  const result = planWindowArrangement(command, sessions);
  expect(result.changes.find((change) => change.id === 'pane')!.content.buffers).toEqual([
    draft('file.ts'),
  ]);
  expect(result.changes.find((change) => change.id === 'returned')!.content.buffers).toEqual([]);
});

it('translates view positions across scopes and pane ids', () => {
  const command = fixture();
  const source = command.entries[0]!.version!.content;
  const oldPane = source.snapshot.layout_tree!;
  const newPane = command.request.arrangement.windows[1]!.layout_tree!;
  const key = `editor:${JSON.stringify([JSON.stringify([`${profileId}:profile`, oldPane.id, tabRefKey(ref('file.ts'))]), 'target', 'view'])}`;
  source.views[key] = { scrollTop: 81 };
  const result = planWindowArrangement(command, sessions).changes.find(
    (change) => change.id === 'pane',
  )!;
  expect(Object.keys(result.content.views).some((key) => key.includes(newPane.id))).toBe(true);
  expect(Object.values(result.content.views)).toContainEqual({ scrollTop: 81 });
});
