import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';
import { sh } from './helpers/git-fixtures.js';

/** The relaxed isolation modes (SPEC §4): shared worktrees and branch deletion. */

describe('separate_branch = false (shared worktree)', () => {
  it('works directly on the base branch; later sessions share the worktree with a concurrency note, not onboarding', async () => {
    const f = fixture();
    const first = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
      prompt: 'first task',
    });
    expect(first.branch).toBe('main');
    expect(first.separate_branch).toBe(false);
    expect(first.worktree_path).toContain('branch-main');
    expect(sh(first.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // The creator onboards; the attacher gets its prompt with a concurrency
    // heads-up but no onboarding preamble (SPEC §4).
    await waitFor(() => f.logs.readTail(first.id, 'agent').includes('READY'));
    expect(f.logs.readTail(first.id, 'agent')).toContain('[puddle onboarding]');

    const second = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
      prompt: 'second task',
    });
    expect(second.worktree_path).toBe(first.worktree_path);
    await waitFor(() => f.logs.readTail(second.id, 'agent').includes('READY'));
    const output = f.logs.readTail(second.id, 'agent');
    expect(output).toContain('working in concurrently');
    expect(output).toContain('second task');
    expect(output).not.toContain('[puddle onboarding]');

    // The shared branch is not badged as session-owned in branch pickers.
    expect(f.stores.sessions.branchesForRepo(f.ids.repo)).toEqual([]);
    // The slug-named shared dir is not an orphan.
    expect(f.worktrees.findOrphanWorktrees(f.stores.repos.get(f.ids.repo))).toEqual([]);

    await f.service.kill(first.id);
    await f.service.kill(second.id);
  });

  it('rejects a requested branch name alongside separate_branch = false', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        separate_branch: false,
        branch: 'alice/some-branch',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'branch_with_shared' });
  });

  it('removes the shared worktree only when its last session archives', async () => {
    const f = fixture();
    const opts = { project_id: f.ids.project, account_id: f.ids.account, separate_branch: false };
    const a = await f.service.create(opts);
    const b = await f.service.create(opts);
    expect(b.worktree_path).toBe(a.worktree_path);
    await f.service.kill(a.id);
    await f.service.kill(b.id);

    await f.service.archive(a.id);
    expect(existsSync(a.worktree_path)).toBe(true); // b still uses it

    await f.service.archive(b.id);
    expect(existsSync(a.worktree_path)).toBe(false);
    expect(sh(f.repoPath, 'rev-parse', '--verify', 'main')).toBeTruthy(); // branch untouched
  });

  it('refuses delete_branch for a shared-branch session', async () => {
    const f = fixture();
    const s = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
    });
    await f.service.kill(s.id);
    await expect(f.service.archive(s.id, false, true)).rejects.toMatchObject({
      status: 400,
      code: 'branch_not_owned',
    });
    await f.service.archive(s.id);
  });
});

describe('archive with delete_branch', () => {
  it('deletes the session branch along with the worktree — no trace left', async () => {
    const f = fixture();
    const s = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'throwaway spike',
    });
    expect(s.branch).toBe('alice/throwaway-spike');
    await f.service.kill(s.id);
    const archived = await f.service.archive(s.id, false, true);
    expect(archived.status).toBe('archived');
    expect(existsSync(s.worktree_path)).toBe(false);
    const branches = sh(f.repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    expect(branches.split('\n')).not.toContain('alice/throwaway-spike');

    const event = f.stores.events.list(s.id).find((e) => e.type === 'archived');
    expect(event?.payload).toMatchObject({ branch_deleted: true });
  });

  it('keeps the branch by default', async () => {
    const f = fixture();
    const s = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'keep me',
    });
    await f.service.kill(s.id);
    await f.service.archive(s.id);
    const branches = sh(f.repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    expect(branches.split('\n')).toContain('alice/keep-me');
  });
});
