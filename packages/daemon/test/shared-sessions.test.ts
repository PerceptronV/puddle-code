import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';
import { sh } from './helpers/git-fixtures.js';

/** The relaxed isolation modes (SPEC §4): shared worktrees and branch deletion. */

describe('separate_branch = false (base branch: own or shared directory)', () => {
  it('sharing the base branch lands in the repo’s own clone (no onboarding, never removed)', async () => {
    const f = fixture();
    const first = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
      separate_worktree: false,
      prompt: 'first task',
    });
    // The clone itself IS the directory when it is on the base branch (SPEC §4).
    expect(first.branch).toBe('main');
    expect(first.separate_branch).toBe(false);
    expect(first.worktree_path).toBe(f.repoPath);

    // It already exists (the user's checkout), so no onboarding — just a
    // concurrency heads-up.
    await waitFor(() => f.logs.readTail(first.id, 'agent').includes('READY'));
    expect(f.logs.readTail(first.id, 'agent')).not.toContain('[puddle onboarding]');

    const second = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
      separate_worktree: false,
      prompt: 'second task',
    });
    expect(second.worktree_path).toBe(f.repoPath);

    // Archiving both must NEVER remove the user's clone.
    await f.service.kill(first.id);
    await f.service.kill(second.id);
    await f.service.archive(first.id);
    await f.service.archive(second.id);
    expect(existsSync(f.repoPath)).toBe(true);
  });

  it('sharing a branch not checked out in the clone uses a canonical shared worktree', async () => {
    const f = fixture();
    sh(f.repoPath, 'branch', 'feature/x'); // exists but not checked out anywhere
    const opts = {
      project_id: f.ids.project,
      account_id: f.ids.account,
      base_branch: 'feature/x',
      separate_branch: false,
      separate_worktree: false,
    };
    const first = await f.service.create({ ...opts, prompt: 'first task' });
    expect(first.branch).toBe('feature/x');
    expect(first.worktree_path).toContain('branch-'); // a canonical shared dir, not the clone
    expect(first.worktree_path).not.toBe(f.repoPath);
    expect(sh(first.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    // A freshly created shared dir onboards the creator (SPEC §4).
    await waitFor(() => f.logs.readTail(first.id, 'agent').includes('READY'));
    expect(f.logs.readTail(first.id, 'agent')).toContain('[puddle onboarding]');

    const second = await f.service.create({ ...opts, prompt: 'second task' });
    expect(second.worktree_path).toBe(first.worktree_path);
    await waitFor(() => f.logs.readTail(second.id, 'agent').includes('READY'));
    expect(f.logs.readTail(second.id, 'agent')).not.toContain('[puddle onboarding]');

    // Removed only when the last session archives.
    await f.service.kill(first.id);
    await f.service.kill(second.id);
    await f.service.archive(first.id);
    expect(existsSync(first.worktree_path)).toBe(true); // second still uses it
    await f.service.archive(second.id);
    expect(existsSync(first.worktree_path)).toBe(false);
  });

  it('defaults to its OWN directory on the base branch (separate_worktree on)', async () => {
    const f = fixture();
    const opts = { project_id: f.ids.project, account_id: f.ids.account, separate_branch: false };
    const a = await f.service.create(opts);
    const b = await f.service.create(opts);
    expect(a.branch).toBe('main');
    expect(a.separate_branch).toBe(false);
    expect(a.worktree_path).not.toContain('branch-'); // own session dir
    expect(a.worktree_path).not.toBe(f.repoPath); // not the clone either
    expect(sh(a.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(b.worktree_path).not.toBe(a.worktree_path); // each its own directory
    await f.service.kill(a.id);
    await f.service.kill(b.id);
  });

  it('join_worktree drops a second agent into an existing worktree', async () => {
    const f = fixture();
    // Agent A on its own feature branch (separate branch, own dir).
    const a = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      branch: 'puddle/xxx',
      prompt: 'agent A',
    });
    expect(a.branch).toBe('puddle/xxx');
    await waitFor(() => f.logs.readTail(a.id, 'agent').includes('READY'));

    // Agent B joins A's directory explicitly by path.
    const b = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: a.worktree_path,
      prompt: 'agent B',
    });
    expect(b.worktree_path).toBe(a.worktree_path);
    expect(b.branch).toBe('puddle/xxx');
    expect(b.separate_branch).toBe(false);
    await waitFor(() => f.logs.readTail(b.id, 'agent').includes('READY'));
    expect(f.logs.readTail(b.id, 'agent')).not.toContain('[puddle onboarding]'); // reuse, no onboarding

    await f.service.kill(a.id);
    await f.service.kill(b.id);
  });

  it('lists the clone as a primary worktree', async () => {
    const f = fixture();
    const wts = await f.worktrees.listWorktrees(f.stores.repos.get(f.ids.repo));
    const primary = wts.find((w) => w.is_primary);
    expect(primary?.path).toBe(f.repoPath);
    expect(primary?.branch).toBe('main');
  });

  it('rejects sharing a directory without also sharing the branch', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        separate_branch: true,
        separate_worktree: false,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'shared_worktree_needs_shared_branch' });
  });

  it('400s joining a path that is not a worktree of the repo', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        separate_branch: false,
        separate_worktree: false,
        join_worktree: '/no/such/worktree',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
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
