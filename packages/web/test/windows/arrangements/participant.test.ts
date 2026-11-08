import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema, type DesktopWorkspaceVersion } from '@puddle/shared';
import { ArrangementParticipant } from '../../../src/features/windows/arrangements/participant';
import { DesktopWorkingSet } from '../../../src/features/windows/state/working-set';
import { DesktopContentState } from '../../../src/features/windows/state/content-state';
import { flattenTabs, makeLeaf } from '../../../src/features/workspace/layout/layout-tree';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const session = '00000000-0000-4000-8000-000000000001';
const arrangementId = 'arrangement';
const draft = (path: string, content: string) => ({ session, path, content, baseMtimeMs: 1 });
const seal = { kind: 'seal-layout' as const, arrangementId, profileId };
const verify = { ...seal, kind: 'verify-layout' as const };
const cancel = { ...seal, kind: 'finish-layout' as const, outcome: 'cancelled' as const };
const commit = { ...cancel, outcome: 'committed' as const };
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function setup(initialArrangement?: string) {
  let stored: DesktopWorkspaceVersion = {
    revision: 1,
    content: {
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: makeLeaf([{ type: 'editor', tab: { session, path: 'original.ts' } }]),
      }),
      buffers: [draft('original.ts', 'original edits')],
      views: {},
    },
  };
  let presentation: DesktopWorkspaceVersion | undefined;
  let route = `/project/${projectId}/session/${session}`;
  const content = new DesktopContentState();
  const write = vi.fn(
    async (request: { revision: number; content: DesktopWorkspaceVersion['content'] }) => {
      stored = { revision: request.revision + 1, content: request.content };
      return stored;
    },
  );
  const errors = vi.fn();
  const owner = new DesktopWorkingSet(
    profileId,
    { read: async () => presentation ?? stored, write },
    content,
    errors,
    undefined,
    initialArrangement !== undefined,
  );
  content.subscribe(() => owner.changed());
  await owner.load(async () => {
    throw new Error('No seed expected');
  });
  const environment = {
    activeProfile: vi.fn(() => profileId),
    owner: async () => owner,
    read: vi.fn(async () => presentation ?? stored),
    initialArrangement: () => initialArrangement,
    fence: vi.fn(),
    suspend: vi.fn<(active: boolean) => void>(),
    staging: vi.fn(),
    route: () => route,
    navigate: vi.fn((next: string) => {
      route = next;
    }),
  };
  const participant = new ArrangementParticipant(environment, 50);
  const present = (version?: DesktopWorkspaceVersion) => {
    presentation = version;
  };
  const plan = (original: DesktopWorkspaceVersion) => ({
    ...original,
    content: {
      ...original.content,
      snapshot: {
        ...original.content.snapshot,
        layout_tree: makeLeaf([
          { type: 'editor' as const, tab: { session, path: 'original.ts' } },
          { type: 'editor' as const, tab: { session, path: 'new.ts' } },
        ]),
      },
      buffers: [...original.content.buffers, draft('new.ts', 'incoming edits')],
    },
  });
  const stage = async (planned: DesktopWorkspaceVersion, destinationRoute = '/') => {
    present(planned);
    const result = participant.command({
      ...seal,
      kind: 'stage-layout',
      version: planned,
      route: destinationRoute,
    });
    await vi.waitFor(() => expect(environment.suspend).toHaveBeenLastCalledWith(false), {
      interval: 1,
    });
    participant.mounted(profileId);
    await result;
  };
  return {
    participant,
    owner,
    content,
    write,
    environment,
    errors,
    present,
    plan,
    stage,
    read: () => stored,
    persist: (version: DesktopWorkspaceVersion) => {
      stored = version;
      presentation = undefined;
    },
  };
}

it('seals views, waits for the matching mounted presentation and adopts only the exact durable commit', async () => {
  const f = await setup();
  const originalRoute = f.environment.route();
  const original = (await f.participant.command(seal))!;
  expect(f.read()).toEqual(original);
  expect(f.environment.suspend).toHaveBeenLastCalledWith(true);
  expect(f.owner.locked()).toBe(true);
  const planned = f.plan(original);
  f.present(planned);
  let accepted = false;
  const staged = f.participant
    .command({ ...seal, kind: 'stage-layout', version: planned, route: '/' })
    .then(() => {
      accepted = true;
    });
  await vi.waitFor(() => expect(f.environment.suspend).toHaveBeenLastCalledWith(false), {
    interval: 1,
  });
  f.participant.mounted('0000000000');
  await Promise.resolve();
  expect(accepted).toBe(false);
  f.environment.navigate(originalRoute);
  f.participant.mounted(profileId);
  expect(accepted).toBe(false);
  f.environment.navigate('/');
  f.participant.mounted(profileId);
  await staged;
  expect(f.owner.get()).toEqual(planned.content.snapshot);
  expect(f.owner.locked()).toBe(true);
  expect(f.write).toHaveBeenCalledTimes(1);
  await expect(f.participant.command(commit)).rejects.toThrow('verified');
  expect(await f.participant.command(verify)).toEqual(planned);
  expect(f.environment.suspend).toHaveBeenLastCalledWith(true);
  await expect(f.participant.command(commit)).rejects.toThrow('not been confirmed');
  expect(f.owner.locked()).toBe(true);
  f.persist({ ...planned, revision: planned.revision + 1 });
  await f.participant.command(commit);
  expect(f.owner.locked()).toBe(false);
  expect(f.environment.fence).toHaveBeenLastCalledWith(false);
  expect(f.environment.staging).toHaveBeenLastCalledWith();
  expect(f.content.capture().buffers).toEqual(planned.content.buffers);
  await f.participant.command(commit); // lost final reply: observation is idempotent
  await expect(f.participant.command(cancel)).rejects.toThrow('already finished');
});

it('retains an edit that finishes while the original views unmount, even when sealing fails', async () => {
  const f = await setup();
  f.environment.suspend.mockImplementationOnce(() => {
    f.content.restore({
      snapshot: f.owner.get(),
      buffers: [draft('late.ts', 'late edit')],
      views: {},
    });
  });
  await expect(f.participant.command(seal)).rejects.toThrow('releasing its views');
  expect(f.owner.locked()).toBe(true);
  await f.participant.command(cancel);
  expect(f.owner.locked()).toBe(false);
  expect(f.read().content.buffers).toEqual([
    draft('original.ts', 'original edits'),
    draft('late.ts', 'late edit'),
  ]);
  expect(flattenTabs(f.owner.get().layout_tree!)).toContainEqual({
    type: 'editor',
    tab: { session, path: 'late.ts', kind: 'file', view: 'source' },
  });
});

it('rolls a staged layout back to its original route and drafts without retaining imported clean-up state', async () => {
  const f = await setup();
  const originalRoute = f.environment.route();
  const original = (await f.participant.command(seal))!;
  await f.stage(f.plan(original));
  f.present(); // native cancellation discards prepared presentation
  await f.participant.command(cancel);
  expect(f.owner.get()).toEqual(original.content.snapshot);
  expect(f.content.capture().buffers).toEqual(original.content.buffers);
  expect(f.environment.route()).toBe(originalRoute);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it('rejects a late staged edit on final verification and preserves it on cancellation', async () => {
  const f = await setup();
  const original = (await f.participant.command(seal))!;
  await f.stage(f.plan(original));
  f.environment.suspend.mockImplementationOnce(() => {
    f.content.restore({
      snapshot: f.owner.get(),
      buffers: [draft('new.ts', 'late staged edit')],
      views: {},
    });
  });
  await expect(f.participant.command(verify)).rejects.toThrow('prepared layout changed');
  f.present();
  await f.participant.command(cancel);
  expect(f.read().content.buffers).toEqual([
    draft('original.ts', 'original edits'),
    draft('new.ts', 'late staged edit'),
  ]);
  expect(f.errors).toHaveBeenCalledOnce();
});

it('bounds a missing mount acknowledgement and allows subsequent cancellation', async () => {
  const f = await setup();
  const original = (await f.participant.command(seal))!;
  const planned = f.plan(original);
  f.present(planned);
  const failed = expect(
    f.participant.command({ ...seal, kind: 'stage-layout', version: planned, route: '/' }),
  ).rejects.toThrow('did not finish mounting');
  await vi.advanceTimersByTimeAsync(51);
  await failed;
  expect(f.owner.locked()).toBe(true);
  expect(f.environment.suspend).toHaveBeenLastCalledWith(true);
  f.participant.mounted(profileId); // late readiness cannot turn a failed stage into acceptance
  await expect(f.participant.command(verify)).rejects.toThrow('not mounted');
  f.present();
  await f.participant.command(cancel);
  expect(f.owner.locked()).toBe(false);
});

it('rejects stale commands, wrong profiles and a different durable prepared revision', async () => {
  const f = await setup();
  f.environment.activeProfile.mockReturnValue('0000000000');
  await expect(f.participant.command(seal)).rejects.toThrow('profile changed');
  expect(f.environment.fence).not.toHaveBeenCalled();
  f.environment.activeProfile.mockReturnValue(profileId);
  const original = (await f.participant.command(seal))!;
  await expect(f.participant.command({ ...cancel, arrangementId: 'other' })).rejects.toThrow(
    'another layout',
  );
  await expect(
    f.participant.command({ ...seal, kind: 'stage-layout', version: f.plan(original), route: '/' }),
  ).rejects.toThrow('durable prepared');
  expect(f.owner.get()).toEqual(original.content.snapshot);
  await f.participant.command(cancel);
});

it('accepts a new staged renderer without writing a seed and leaves it sealed on cancellation', async () => {
  const f = await setup(arrangementId);
  await expect(f.participant.command(seal)).rejects.toThrow('prepared window');
  await f.stage(f.read());
  expect(await f.participant.command(verify)).toEqual(f.read());
  await f.participant.command(cancel);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.owner.locked()).toBe(true);
  expect(f.environment.suspend).toHaveBeenLastCalledWith(true);
  expect(f.environment.fence).not.toHaveBeenCalledWith(false);
});

it('adopts a newly created window only after its prepared revision commits', async () => {
  const f = await setup(arrangementId);
  const planned = f.read();
  await f.stage(planned, `/project/${projectId}`);
  await f.participant.command(verify);
  f.persist({ ...planned, revision: planned.revision + 1 });
  await f.participant.command(commit);
  expect(f.owner.locked()).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
});

it('rechecks retiring sources and requires a fresh vote if a sealed source becomes a staged destination', async () => {
  const f = await setup();
  const original = (await f.participant.command(seal))!;
  expect(await f.participant.command(verify)).toEqual(original);
  await f.stage(f.plan(original));
  await expect(f.participant.command(commit)).rejects.toThrow('verified');
  f.environment.navigate('/settings');
  await expect(f.participant.command(verify)).rejects.toThrow('route changed');
  f.present();
  await f.participant.command(cancel);
});

it('lets a retiring source veto a late buffer change before its native window can close', async () => {
  const f = await setup();
  await f.participant.command(seal);
  f.content.restore({
    snapshot: f.owner.get(),
    buffers: [draft('late.ts', 'late source edit')],
    views: {},
  });
  await expect(f.participant.command(verify)).rejects.toThrow('prepared layout changed');
  await f.participant.command(cancel);
  expect(f.read().content.buffers).toContainEqual(draft('late.ts', 'late source edit'));
});
