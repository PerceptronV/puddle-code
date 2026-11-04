import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '@puddle/shared/node';
import type { HostPurgeReview } from '@puddle/shared';
import { git, GitError } from '../../../git/exec.js';

/** Bounded directory enumeration; never follow a worktree/container symlink. */
export function purgeDirectoryNames(path: string, limit: number): string[] {
  const directory = opendirSync(path);
  try {
    const names: string[] = [];
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return names.sort();
      if (names.length === limit) throw new Error('Purge inventory exceeds its limit');
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
}

export async function reviewPurgeWorktrees(
  home: string,
  requireCurrent: () => void,
): Promise<{ worktrees: HostPurgeReview['worktrees']; fingerprint: string }> {
  const root = join(home, 'worktrees');
  const worktrees: HostPurgeReview['worktrees'] = [];
  const evidence: unknown[] = [];
  const deadline = Date.now() + 30_000;
  const current = () => {
    requireCurrent();
    if (Date.now() >= deadline) throw new Error('Purge worktree review exceeded its deadline');
  };
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('Unknown worktree inventory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { worktrees, fingerprint: digest('[]') };
    throw error;
  }
  for (const repo of purgeDirectoryNames(root, 4096)) {
    const container = join(root, repo);
    if (!lstatSync(container).isDirectory()) throw new Error('Unknown worktree container');
    for (const name of purgeDirectoryNames(container, 4096 - worktrees.length)) {
      current();
      const path = join(container, name);
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        realpathSync(path) !== join(realpathSync(home), 'worktrees', repo, name)
      )
        throw new Error('Linked worktree cannot be reviewed for purge');
      const inspect = (args: string[]) =>
        git(['-c', 'core.fsmonitor=false', ...args], {
          cwd: path,
          timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
          maxOutputBytes: 1024 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
            ),
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        });
      if (realpathSync(await inspect(['rev-parse', '--show-toplevel'])) !== realpathSync(path))
        throw new Error('Git inspection resolved another worktree');
      current();
      const status = await inspect(['status', '--porcelain=v1', '--untracked-files=all']);
      current();
      let head: string | null = null;
      try {
        head = await inspect(['rev-parse', '--verify', '--quiet', 'HEAD']);
      } catch (error) {
        if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
      }
      current();
      const local = await inspect([
        'rev-list',
        '--max-count=1',
        '--all',
        ...(head ? [head] : []),
        '--not',
        '--remotes',
      ]);
      current();
      worktrees.push({ path, dirty: status.length > 0, local_only: local.length > 0 });
      evidence.push({ path, device: stat.dev, inode: stat.ino, status, head, local });
    }
  }
  return { worktrees, fingerprint: digest(JSON.stringify(evidence)) };
}
