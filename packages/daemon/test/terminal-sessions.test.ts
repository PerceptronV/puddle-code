import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';
import { sh } from './helpers/git-fixtures.js';

/** Terminal sessions (SPEC §4): a plain shell PTY, no account, no agent. */

// A terminal session spawns the real `$SHELL`. The interactive login shell on a
// dev box (often zsh with a heavy rc) is slow to start and, spawned repeatedly
// across the parallel suite, can starve sibling tests — so pin this file's fork
// to a lightweight bash. Vitest's default `forks` pool isolates this env change
// to this file's own child process.
process.env.SHELL = 'bash';

describe('terminal sessions', () => {
  it('opens a shell on the base branch by default — no account, no agent, no onboarding', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
    });

    // Shape: no account/agent, and separate_branch defaults OFF (shared base).
    expect(session.kind).toBe('terminal');
    expect(session.account_id).toBeNull();
    expect(session.agent_type).toBeNull();
    expect(session.separate_branch).toBe(false);
    expect(session.branch).toBe('main');
    expect(session.worktree_path).toContain('branch-main');
    expect(sh(session.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // The shell comes up (starting → running on its first prompt) and never
    // receives the onboarding preamble an agent would.
    await waitFor(() => f.service.get(session.id).status === 'running');
    expect(f.logs.readTail(session.id, 'agent')).not.toContain('[puddle onboarding]');

    await f.service.kill(session.id);
    expect(f.service.get(session.id).status).toBe('exited');
  });

  it('can take a separate branch, and resume relaunches a fresh shell', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: true,
    });
    expect(session.separate_branch).toBe(true);
    expect(session.branch).not.toBe('main');
    expect(session.branch.startsWith('alice/')).toBe(true);

    await waitFor(() => f.service.get(session.id).status === 'running');
    await f.service.kill(session.id);
    expect(f.service.get(session.id).status).toBe('exited');

    // "Resume" a terminal = relaunch a shell in the same worktree (there is no
    // conversation to restore), so it goes live again like any other session.
    const resumed = await f.service.resume(session.id);
    expect(resumed.status).toBe('running');
    await waitFor(() => f.service.get(session.id).status === 'running');
    await f.service.kill(session.id);
  });

  it('rejects a branch name alongside the default shared worktree', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        kind: 'terminal',
        branch: 'some-branch',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'branch_with_shared' });
  });

  it('still requires an account for an agent session', async () => {
    const f = fixture();
    await expect(f.service.create({ project_id: f.ids.project })).rejects.toMatchObject({
      status: 400,
      code: 'account_required',
    });
  });
});
