import { expect, it, vi } from 'vitest';
import {
  savedLayoutSchema,
  uiStateSnapshotSchema,
  type DesktopArrangementCapture,
} from '@puddle/shared';
import {
  arrangementSignature,
  captureCatalogueLayout,
  catalogueArrangement,
} from '../../../src/features/windows/arrangements/catalogue';
import { CatalogueApplication } from '../../../src/features/windows/arrangements/catalogue-application';
import { flattenTabs, makeLeaf } from '../../../src/features/workspace/layout/layout-tree';

const profile = 'aaaaaaaaaa';
const project = '1111111111';
const session = '00000000-0000-4000-8000-000000000001';
const tree = makeLeaf([{ type: 'editor', tab: { session, path: 'a.ts' } }]);
const snapshot = uiStateSnapshotSchema.parse({ layout_mode: 'profile', layout_tree: tree });
const capture: DesktopArrangementCapture = {
  entries: [
    {
      identity: { kind: 'host', id: 'host' },
      snapshot: uiStateSnapshotSchema.parse({ layout_mode: 'project' }),
      open: true,
      returnedProject: false,
      revision: 1,
    },
    {
      identity: { kind: 'project', id: 'returned', profileId: profile, projectId: project },
      snapshot,
      open: false,
      returnedProject: true,
      revision: 2,
    },
  ],
};
const sessions = new Map([[session, project]]);

it('captures a returned project as host content without reopening its dedicated window', () => {
  const before = structuredClone(capture);
  const saved = captureCatalogueLayout(capture, 'project', project, sessions);
  expect(saved.window_arrangement.windows.map((slot) => slot.kind)).toEqual(['host']);
  expect(
    flattenTabs(saved.window_arrangement.windows[0]!.project_layouts[project]!.layout_tree!),
  ).toEqual(tree.tabs);
  expect(capture).toEqual(before);
});

it('signs independent window structure and inactive slices but ignores native ids and focus', () => {
  const a = captureCatalogueLayout(capture, 'profile', null, sessions).window_arrangement;
  const b = structuredClone(a);
  b.windows[0]!.key = 'different';
  b.windows[0]!.project_id = project;
  const leaf = b.windows[0]!.project_layouts[project]!.layout_tree!;
  if (leaf.kind !== 'leaf') throw new Error('fixture');
  leaf.id = 'new-pane-id';
  leaf.activeKey = null;
  expect(arrangementSignature(b)).toBe(arrangementSignature(a));
  b.windows.push({
    key: 'pane',
    kind: 'pane',
    project_id: project,
    layout_mode: 'profile',
    layout_tree: tree,
    active_session: null,
    project_layouts: {},
  });
  expect(arrangementSignature(b)).not.toBe(arrangementSignature(a));
  const reversed = { ...b, windows: [...b.windows].reverse() };
  expect(arrangementSignature(reversed)).toBe(arrangementSignature(b));
  b.windows[0]!.project_layouts[project]!.layout_tree = null;
  expect(arrangementSignature(reversed)).not.toBe(arrangementSignature(a));
});

it('converts a legacy project layout to one scoped host slot', () => {
  const saved = savedLayoutSchema.parse({
    id: 1,
    name: 'Legacy',
    profile_id: profile,
    scope: 'project',
    project_id: project,
    layout_tree: tree,
    active_session: null,
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z',
  });
  const arrangement = catalogueArrangement(saved);
  expect(arrangement.windows).toHaveLength(1);
  expect(arrangement.windows[0]!.project_layouts[project]!.layout_tree).toEqual(tree);
  expect(arrangement.windows[0]!.layout_tree).toBeNull();
});

const request = () => ({
  id: 'apply-one',
  profileId: profile,
  scope: 'profile' as const,
  arrangement: captureCatalogueLayout(capture, 'profile', null, sessions).window_arrangement,
});

it('observes a lost apply reply without dispatching another application', async () => {
  const controller = new CatalogueApplication();
  const api = {
    capture: vi.fn(),
    apply: vi.fn().mockRejectedValue(new Error('lost reply')),
    observe: vi.fn().mockResolvedValue({ status: 'committed' }),
  };
  expect(await controller.apply(api, request())).toEqual({ status: 'committed' });
  expect(api.apply).toHaveBeenCalledTimes(1);
  expect(api.observe).toHaveBeenCalledWith({ id: 'apply-one', profileId: profile });
  expect(controller.busy()).toBe(false);
});

it('retains an uncertain id across popover remounts and observes it before accepting another load', async () => {
  const controller = new CatalogueApplication();
  const api = {
    capture: vi.fn(),
    apply: vi.fn().mockRejectedValue(new Error('lost reply')),
    observe: vi.fn().mockResolvedValue({ status: 'unknown' }),
  };
  expect(await controller.apply(api, request())).toEqual({ status: 'unknown' });
  await expect(controller.apply(api, { ...request(), id: 'another' })).rejects.toThrow(
    'still unknown',
  );
  api.observe.mockResolvedValue({ status: 'cancelled' });
  await expect(controller.apply(api, { ...request(), id: 'another' })).rejects.toThrow(
    'previous layout was cancelled',
  );
  expect(api.apply).toHaveBeenCalledTimes(1);
  expect(api.observe).toHaveBeenLastCalledWith({ id: 'apply-one', profileId: profile });
});

it('rejects a concurrent application while a renderer is being replaced', async () => {
  const controller = new CatalogueApplication();
  let finish!: (value: { status: 'committed' }) => void;
  const api = {
    capture: vi.fn(),
    apply: vi.fn(
      () =>
        new Promise<{ status: 'committed' }>((resolve) => {
          finish = resolve;
        }),
    ),
    observe: vi.fn(),
  };
  const pending = controller.apply(api, request());
  expect(controller.busy()).toBe(true);
  await expect(controller.apply(api, request())).rejects.toThrow('already loading');
  finish({ status: 'committed' });
  await pending;
  expect(controller.busy()).toBe(false);
});
