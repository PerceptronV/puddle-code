import { afterEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopWindowTransfersBridge,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import { DesktopWorkingSet } from '../../../src/features/windows/state/working-set';
import { DesktopContentState } from '../../../src/features/windows/state/content-state';
import {
  transferDock,
  transferProjectToHost,
} from '../../../src/features/windows/transfers/pane-transfer';
import { flattenTabs } from '../../../src/features/workspace/layout/layout-tree';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const session = '00000000-0000-4000-8000-000000000001';
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function setup() {
  vi.useFakeTimers();
  let saved: DesktopWorkspaceVersion = {
    revision: 1,
    content: {
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: {
          kind: 'leaf',
          id: 'pane',
          tabs: [{ type: 'editor', tab: { session, path: 'a.ts' } }],
          activeKey: null,
        },
      }),
      buffers: [{ session, path: 'a.ts', content: 'unsaved', baseMtimeMs: 1 }],
      views: {},
    },
  };
  const content = new DesktopContentState();
  const owner = new DesktopWorkingSet(
    profileId,
    {
      read: async () => saved,
      write: async (request) => {
        saved = { revision: request.revision + 1, content: request.content };
        return saved;
      },
    },
    content,
    vi.fn(),
  );
  content.subscribe(() => owner.changed());
  await owner.load(async () => saved.content.snapshot);
  let source = saved.content;
  const bridge: DesktopWindowTransfersBridge = {
    preparePane: vi.fn(),
    prepareDock: vi.fn(async (request) => {
      source = request.source;
    }),
    commit: vi.fn(async () => {
      saved = { revision: saved.revision + 1, content: source };
      return saved;
    }),
    observe: vi.fn(),
    cancel: vi.fn(),
    accept: vi.fn(),
    retire: vi.fn(),
  };
  return { owner, bridge, content, saved: () => saved };
}

it('retires only after releasing source models and persisting a final empty capture', async () => {
  const f = await setup();
  const suspend = vi.fn();
  await transferDock(f.owner, f.bridge, projectId, 'pane', 'host', vi.fn(), suspend);
  expect(suspend).toHaveBeenCalledWith(true);
  expect(suspend).not.toHaveBeenCalledWith(false);
  expect(f.bridge.retire).toHaveBeenCalledWith(
    expect.objectContaining({ profileId, revision: f.saved().revision }),
  );
  expect(f.saved().content.buffers).toEqual([]);
  expect(flattenTabs(f.saved().content.snapshot.layout_tree!)).toEqual([]);
});

it('seals every project view before planning and includes cleanup edits in its final capture', async () => {
  const f = await setup();
  const suspend = vi.fn((active: boolean) => {
    if (active)
      f.content.restore({
        snapshot: f.owner.get(),
        buffers: [
          { session, path: 'a.ts', content: 'cleanup before final capture', baseMtimeMs: 1 },
        ],
        views: {},
      });
  });
  f.bridge.prepareProjectDock = vi.fn(async (request) => {
    expect(suspend).toHaveBeenCalledWith(true);
    expect(request.destination.buffers[0]?.content).toBe('cleanup before final capture');
    expect(request.source.buffers).toEqual([]);
    expect(flattenTabs(request.source.snapshot.layout_tree!)).toEqual([]);
    await f.bridge.prepareDock!({ ...request });
  });
  await transferProjectToHost(f.owner, f.bridge, projectId, 'host', vi.fn(), suspend);
  expect(f.bridge.commit).toHaveBeenCalledOnce();
  expect(f.bridge.retire).not.toHaveBeenCalled();
  expect(suspend).not.toHaveBeenCalledWith(false);
});

it('restores the complete sealed project if the host refuses its merge', async () => {
  const f = await setup();
  const original = f.owner.get();
  f.bridge.prepareProjectDock = vi.fn().mockRejectedValue(new Error('dirty conflict'));
  f.bridge.observe = vi.fn(async () => ({ status: 'cancelled', version: f.saved() }));
  const suspend = vi.fn();
  await expect(
    transferProjectToHost(f.owner, f.bridge, projectId, 'host', vi.fn(), suspend),
  ).rejects.toThrow('dirty conflict');
  expect(f.bridge.commit).not.toHaveBeenCalled();
  expect(suspend).toHaveBeenLastCalledWith(false);
  expect(f.owner.locked()).toBe(false);
  expect(f.owner.get()).toEqual(original);
  expect(f.content.capture().buffers[0]?.content).toBe('unsaved');
});

it('keeps a late cleanup draft visible in the source instead of retiring its window', async () => {
  const f = await setup();
  const suspend = vi.fn((active: boolean) => {
    if (active)
      f.content.restore({
        snapshot: f.owner.get(),
        views: {},
        buffers: [{ session, path: 'a.ts', content: 'late cleanup edit', baseMtimeMs: 1 }],
      });
  });
  await transferDock(f.owner, f.bridge, projectId, 'pane', 'host', vi.fn(), suspend);
  expect(f.bridge.retire).not.toHaveBeenCalled();
  expect(f.saved().content.buffers[0]?.content).toBe('late cleanup edit');
  expect(flattenTabs(f.owner.get().layout_tree!)).toHaveLength(1);
  expect(suspend).toHaveBeenLastCalledWith(false);
  expect(f.owner.locked()).toBe(false);
});

it('leaves an editable source when native retirement fails after the move committed', async () => {
  const f = await setup();
  f.bridge.retire = vi.fn().mockRejectedValue(new Error('Native window could not close'));
  const suspend = vi.fn();
  await expect(
    transferDock(f.owner, f.bridge, projectId, 'pane', 'host', vi.fn(), suspend),
  ).rejects.toThrow('could not close');
  expect(f.bridge.commit).toHaveBeenCalledOnce();
  expect(f.bridge.retire).toHaveBeenCalledOnce();
  expect(f.owner.locked()).toBe(false);
  expect(suspend).toHaveBeenLastCalledWith(false);
});
