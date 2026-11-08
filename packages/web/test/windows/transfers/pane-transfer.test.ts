import { expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopWindowTransfersBridge,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import { DesktopWorkingSet } from '../../../src/features/windows/state/working-set';
import { transferPane } from '../../../src/features/windows/transfers/pane-transfer';

async function setup() {
  const session = '00000000-0000-4000-8000-000000000001';
  let text = 'unsaved';
  let stored: DesktopWorkspaceVersion = {
    revision: 1,
    content: {
      snapshot: uiStateSnapshotSchema.parse({
        layout_tree: {
          kind: 'leaf',
          id: 'pane',
          activeKey: null,
          tabs: [{ type: 'editor', tab: { session, path: 'a.ts' } }],
        },
      }),
      buffers: [],
      views: {},
    },
  };
  const content = {
    capture: () => ({
      buffers: [{ session, path: 'a.ts', content: text, baseMtimeMs: 1 }],
      views: {},
    }),
    restore: vi.fn(),
  };
  const owner = new DesktopWorkingSet(
    '1234567890',
    {
      read: async () => structuredClone(stored),
      write: async (request) => {
        stored = structuredClone({ revision: request.revision + 1, content: request.content });
        return stored;
      },
    },
    content,
    vi.fn(),
  );
  await owner.load(async () => stored.content.snapshot);
  let status: 'unknown' | 'prepared' | 'committed' | 'cancelled' = 'unknown';
  let source = stored.content;
  const bridge: DesktopWindowTransfersBridge = {
    preparePane: vi.fn(async (request) => {
      status = 'prepared';
      source = request.source;
    }),
    commit: vi.fn(async () => {
      status = 'committed';
      stored = { revision: stored.revision + 1, content: source };
      return stored;
    }),
    cancel: vi.fn(async () => {
      status = 'cancelled';
      return { status, version: stored };
    }),
    observe: vi.fn(async () => ({ status, version: stored })),
    accept: vi.fn(),
  };
  return {
    owner,
    content,
    bridge,
    read: () => stored,
    edit: () => {
      text = 'late edit';
      owner.changed();
    },
  };
}

it('aborts a stale capture without replacing newer live text with the captured version', async () => {
  vi.useFakeTimers();
  try {
    const { owner, content, bridge, edit } = await setup();
    const prepare = bridge.preparePane;
    bridge.preparePane = async (request) => {
      await prepare(request);
      edit();
    };
    const fence = vi.fn();
    await expect(transferPane(owner, bridge, 'abcdef1234', 'pane', fence)).rejects.toThrow(
      'pane changed',
    );
    expect(bridge.commit).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalledOnce();
    expect(owner.locked()).toBe(false);
    expect(content.restore).toHaveBeenCalledOnce();
    expect(content.capture().buffers[0]!.content).toBe('late edit');
    expect(fence).toHaveBeenLastCalledWith(false);
  } finally {
    vi.useRealTimers();
  }
});

it('retains a dirty edit that arrives after confirmation as source recovery', async () => {
  const { owner, bridge, edit, read } = await setup();
  const commit = bridge.commit;
  bridge.commit = async (request) => {
    const result = await commit(request);
    edit();
    return result;
  };
  await transferPane(owner, bridge, 'abcdef1234', 'pane', vi.fn());
  expect(read().content.buffers[0]?.content).toBe('late edit');
  expect(read().revision).toBe(4); // Capture, commit, then the late recovery draft.
  const tree = read().content.snapshot.layout_tree;
  expect(tree?.kind === 'leaf' && tree.tabs[0]?.type === 'editor' && tree.tabs[0].tab.path).toBe(
    'a.ts',
  );
});

it('observes an accepted commit after its reply is lost without replaying the move', async () => {
  const { owner, bridge } = await setup();
  const commit = bridge.commit;
  bridge.commit = vi.fn(async (request) => {
    await commit(request);
    throw new Error('Lost reply');
  });
  await transferPane(owner, bridge, 'abcdef1234', 'pane', vi.fn());
  expect(bridge.preparePane).toHaveBeenCalledOnce();
  expect(bridge.commit).toHaveBeenCalledOnce();
  expect(bridge.cancel).not.toHaveBeenCalled();
  expect(owner.locked()).toBe(false);
  expect(owner.get().layout_tree?.kind).toBe('leaf');
  if (owner.get().layout_tree?.kind === 'leaf') expect(owner.get().layout_tree?.tabs).toEqual([]);
});

it('does not unlock an ongoing transfer when an overlapping quit is cancelled', async () => {
  const { owner } = await setup();
  await owner.freeze();
  await expect(owner.checkpoint()).rejects.toThrow('transfer is still pending');
  owner.resumeCheckpoint();
  expect(owner.locked()).toBe(true);
});
