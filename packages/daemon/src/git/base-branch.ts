import type { Repo } from '@puddle/shared';
import { git, GitError } from './exec.js';

/** Resolve an empty default afresh at the registered clone, never a session worktree. */
export async function resolveDefaultBaseBranch(
  repo: Pick<Repo, 'path' | 'default_base_branch'>,
): Promise<string> {
  if (repo.default_base_branch) return repo.default_base_branch;
  try {
    return await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.path });
  } catch (error) {
    // Detached HEAD has no branch; use the fallback without changing the saved default.
    if (error instanceof GitError && error.exitCode === 1) return 'main';
    throw error;
  }
}
