import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCreationCaller } from '../../../src/sessions/creation/caller.js';
import type { RuntimeLauncher } from '../../../src/runtime/lifecycle/launcher.js';
import { fixture } from '../../helpers/daemon-fixtures.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.service.beginShutdown();
    f.onboarding.dispose();
  }
});
function setup(independent = true) {
  const launch = vi.fn<RuntimeLauncher['launch']>(async () => {});
  const f = fixture({
    runtimeLauncher: independent ? ({ launch } as unknown as RuntimeLauncher) : undefined,
  });
  fixtures.push(f);
  const caller: SessionCreationCaller = {
    identity: 'a'.repeat(64),
    check: vi.fn(),
    record: vi.fn(),
    bind: vi.fn(),
  };
  const input = {
    project_id: f.ids.project,
    account_id: f.ids.account,
    separate_branch: false,
    separate_worktree: false,
    join_worktree: f.repoPath,
  };
  return { f, launch, caller, input };
}

it('carries the same private caller from the placement transaction into independent launch', async () => {
  const { f, launch, caller, input } = setup();
  const session = await f.service.create(input, 'interactive', undefined, caller);
  expect(caller.record).toHaveBeenCalledExactlyOnceWith(session.id);
  expect(launch).toHaveBeenCalledOnce();
  expect(launch.mock.calls[0]![2]?.creation).toBe(caller);
  expect(f.ptys.liveCount()).toBe(0);
});

it('rolls back placement creation when the caller rejects and never reaches launch', async () => {
  const { f, launch, caller, input } = setup();
  caller.record = () => {
    throw new Error('Caller no longer active');
  };
  const before = f.stores.sessions.list();
  await expect(f.service.create(input, 'interactive', undefined, caller)).rejects.toThrow(
    'no longer active',
  );
  expect(f.stores.sessions.list()).toEqual(before);
  expect(launch).not.toHaveBeenCalled();
});

it('rechecks caller authority after asynchronous worktree resolution', async () => {
  const { f, launch, caller, input } = setup();
  let active = true;
  caller.check = () => {
    if (!active) throw new Error('Caller expired');
  };
  const list = f.worktrees.listWorktrees.bind(f.worktrees);
  vi.spyOn(f.worktrees, 'listWorktrees').mockImplementation(async (...args) => {
    const result = await list(...args);
    active = false;
    return result;
  });
  await expect(f.service.create(input, 'interactive', undefined, caller)).rejects.toThrow(
    'expired',
  );
  expect(caller.record).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it('refuses legacy creation, implicit worktrees and combined initial task prompts', async () => {
  const legacy = setup(false);
  await expect(
    legacy.f.service.create(legacy.input, 'interactive', undefined, legacy.caller),
  ).rejects.toThrow('independent agent');
  const { f, launch, caller, input } = setup();
  for (const change of [
    { join_worktree: undefined },
    { separate_branch: true },
    { prompt: 'task' },
  ])
    await expect(
      f.service.create({ ...input, ...change }, 'interactive', undefined, caller),
    ).rejects.toThrow('independent agent');
  expect(launch).not.toHaveBeenCalled();
});
