import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';

/**
 * "Open terminal in directory" (SPEC §8): the shell starts in a subdirectory of
 * the worktree the session still belongs to.
 */
describe('terminal session cwd', () => {
  it('starts the shell in the requested subdirectory', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const sub = join(owner.worktree_path, 'nested', 'deep');
    mkdirSync(sub, { recursive: true });

    const term = await f.service.create({
      project_id: f.ids.project,
      kind: 'terminal',
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
      cwd: 'nested/deep',
    });
    // The session still belongs to the WORKTREE — only the shell's cwd differs.
    expect(term.worktree_path).toBe(owner.worktree_path);

    // Ask the shell where it is; the fake terminal is a real $SHELL.
    f.ptys.write(term.id, 'agent', 'pwd\n');
    await waitFor(() => f.logs.readTail(term.id, 'agent').includes('nested/deep'), 10_000);
    expect(f.logs.readTail(term.id, 'agent')).toContain('nested/deep');

    await f.service.kill(term.id).catch(() => undefined);
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('rejects a cwd that escapes the worktree, or is not a directory', async () => {
    const f = fixture();
    const owner = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const base = {
      project_id: f.ids.project,
      kind: 'terminal' as const,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: owner.worktree_path,
    };
    await expect(f.service.create({ ...base, cwd: '../../etc' })).rejects.toMatchObject({
      code: 'path_outside_worktree',
    });
    await expect(f.service.create({ ...base, cwd: 'no-such-dir' })).rejects.toMatchObject({
      code: 'cwd_not_a_directory',
    });
    await f.service.kill(owner.id).catch(() => undefined);
  });

  it('refuses a cwd on an agent session — it is a terminal-only option', async () => {
    const f = fixture();
    await expect(
      f.service.create({ project_id: f.ids.project, account_id: f.ids.account, cwd: 'src' }),
    ).rejects.toMatchObject({ code: 'cwd_terminal_only' });
  });
});
