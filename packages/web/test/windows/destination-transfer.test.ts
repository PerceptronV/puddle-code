import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopWorkspaceVersion,
  type DesktopWindowTransferCommand,
} from '@puddle/shared';
import { DesktopWorkingSet } from '../../src/features/windows/working-set';
import { DesktopContentState } from '../../src/features/windows/content-state';
import { DestinationTransfer } from '../../src/features/windows/destination-transfer';
import { makeLeaf, flattenTabs } from '../../src/features/workspace/layout/layout-tree';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const session = '00000000-0000-4000-8000-000000000001';
const draft = (text: string) => ({ session, path: 'file.ts', content: text, baseMtimeMs: 1 });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function setup() {
  let saved: DesktopWorkspaceVersion = {
    revision: 1,
    content: {
      snapshot: uiStateSnapshotSchema.parse({ layout_mode: 'profile', layout_tree: makeLeaf() }),
      buffers: [],
      views: {},
    },
  };
  let presentation = saved;
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
  const environment = {
    activeProfile: vi.fn(() => profileId),
    owner: async () => owner,
    read: async () => presentation,
    fence: vi.fn(),
    suspend: vi.fn(),
    staging: vi.fn(),
    route: () => '/project/0000000001/session/00000000-0000-4000-8000-000000000001',
    navigate: vi.fn(),
  };
  const destination = new DestinationTransfer(environment);
  const plan: Extract<DesktopWindowTransferCommand, { kind: 'plan-pane' }> = {
    kind: 'plan-pane',
    transferId: 'move',
    profileId,
    projectId,
    content: {
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: makeLeaf([{ type: 'editor', tab: { session, path: 'file.ts' } }]),
      }),
      buffers: [draft('incoming')],
      views: {},
    },
  };
  const stage = { kind: 'stage-window' as const, transferId: 'move', profileId };
  const cancel = { ...stage, kind: 'cancel-window' as const };
  return {
    owner,
    content,
    environment,
    destination,
    plan,
    stage,
    cancel,
    read: () => saved,
    present: (version: DesktopWorkspaceVersion) => {
      presentation = version;
    },
  };
}

it('keeps existing content until preparation, remounts staged models, and adopts the exact committed revision', async () => {
  const f = await setup();
  const original = f.owner.get();
  const planned = (await f.destination.command(f.plan))!;
  expect(f.owner.get()).toEqual(original);
  expect(f.owner.locked()).toBe(true);
  f.present(planned);
  await f.destination.command(f.stage);
  expect(f.environment.suspend.mock.calls).toEqual([[true], [false]]);
  expect(f.owner.get()).toEqual(planned.content.snapshot);
  expect(f.content.buffer(draft(''))?.content).toBe('incoming');
  expect(f.environment.staging).toHaveBeenLastCalledWith('move');
  expect(
    await f.destination.committed('move', { ...planned, revision: planned.revision + 1 }),
  ).toBe(true);
  expect(f.owner.locked()).toBe(false);
  expect(f.environment.fence).toHaveBeenLastCalledWith(false);
  expect(f.environment.navigate).toHaveBeenLastCalledWith(`/project/${projectId}`);
});

it('rolls a staged destination back without retiring its existing window or keeping imported drafts', async () => {
  const f = await setup();
  const original = f.owner.get();
  const planned = (await f.destination.command(f.plan))!;
  f.present(planned);
  await f.destination.command(f.stage);
  await f.destination.command(f.cancel);
  expect(f.owner.get()).toEqual(original);
  expect(f.content.capture().buffers).toEqual([]);
  expect(f.owner.locked()).toBe(false);
  expect(f.environment.navigate).toHaveBeenLastCalledWith(f.environment.route());
  expect(f.environment.suspend).toHaveBeenLastCalledWith(false);
});

it('rejects dirty conflicts and leaves the destination editable with its own text', async () => {
  const f = await setup();
  f.content.restore({ snapshot: f.owner.get(), buffers: [draft('existing edits')], views: {} });
  await expect(f.destination.command(f.plan)).rejects.toThrow('different unsaved edits');
  expect(f.content.capture().buffers).toEqual([draft('existing edits')]);
  expect(f.owner.locked()).toBe(false);
  expect(f.environment.suspend).not.toHaveBeenCalled();
});

it('detects a late edit before staging and retains it visibly on cancellation', async () => {
  const f = await setup();
  await f.destination.command(f.plan);
  f.content.restore({
    snapshot: f.owner.get(),
    buffers: [draft('late destination edit')],
    views: {},
  });
  await expect(f.destination.command(f.stage)).rejects.toThrow('destination changed');
  await f.destination.command(f.cancel);
  expect(f.read().content.buffers).toEqual([draft('late destination edit')]);
  expect(flattenTabs(f.owner.get().layout_tree!)).toEqual([
    { type: 'editor', tab: { session, path: 'file.ts', kind: 'file', view: 'source' } },
  ]);
  expect(f.owner.locked()).toBe(false);
});

it('does not let a stale cancellation unlock a different transfer or accept another profile', async () => {
  const f = await setup();
  f.environment.activeProfile.mockReturnValue('0000000000');
  await expect(f.destination.command(f.plan)).rejects.toThrow('same profile');
  f.environment.activeProfile.mockReturnValue(profileId);
  await f.destination.command(f.plan);
  await expect(f.destination.command({ ...f.cancel, transferId: 'other' })).rejects.toThrow(
    'another transfer',
  );
  expect(f.owner.locked()).toBe(true);
  await f.destination.command(f.cancel);
});
