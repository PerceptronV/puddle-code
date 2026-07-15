import type { GitStatus, GitStatusEntry } from '@puddle/shared';
import { git } from '../git/exec.js';

/**
 * Per-path working-tree status for the file explorer's git decorations
 * (SPEC §8) — the tree analogue of `inspect.ts`'s diff family, but with the
 * full VSCode-grade status set (distinct `untracked`, `conflicted`, `ignored`).
 * The porcelain parse is pure and unit-tested; `worktreeGitStatus` is the thin
 * git-running wrapper.
 */

/**
 * Collapse a porcelain XY status pair to a single decoration status.
 *
 * Precedence, highest first: conflicted (any unmerged pair) > untracked (`??`)
 * > ignored (`!!`) > added > renamed > modified > deleted. The added/renamed/
 * modified/deleted checks look at BOTH columns (index X and worktree Y), so a
 * staged-add-then-modified (`AM`) reads as added and a rename-then-edit (`RM`)
 * reads as renamed — matching what VSCode's explorer badge shows.
 */
export function statusFromXY(x: string, y: string): GitStatus {
  if (x === '?') return 'untracked'; // `??`
  if (x === '!') return 'ignored'; // `!!`
  // Unmerged (conflict) states: either side is `U`, or both-added / both-deleted.
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflicted';
  }
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'modified';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified'; // C (copy) and any unexpected pair — treat as a change
}

/**
 * Parse `git status --porcelain=v1 -z` output into one entry per path.
 *
 * The `-z` stream is a run of NUL-terminated records `XY<space>PATH`; a
 * rename/copy record is followed by a second NUL-terminated token, its origin
 * path (verified against git: `RM new\0old\0`). We decorate the destination
 * (which is the one that exists on disk) and consume — but discard — the origin
 * token, since `GitStatusEntry` carries only `{ path, status }`.
 */
export function parsePorcelainStatus(raw: string): GitStatusEntry[] {
  const tokens = raw.split('\0');
  const entries: GitStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++];
    if (!record || record.length < 3) continue; // trailing empty token
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3); // skip the two status chars + the separating space
    // A rename/copy record has a trailing origin-path token to consume.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    entries.push({ path, status: statusFromXY(x, y) });
  }
  return entries;
}

/**
 * Every changed / untracked / ignored-but-present path in the worktree.
 * `--ignored=matching` reports only ignored paths that actually exist (so the
 * tree can grey them without walking every ignore rule); `--untracked-files=all`
 * lists files inside untracked directories individually so each tree row can be
 * decorated; `-M` turns move pairs into a single renamed entry.
 */
export async function worktreeGitStatus(worktree: string): Promise<GitStatusEntry[]> {
  const raw = await git(
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '-M'],
    { cwd: worktree },
  );
  return parsePorcelainStatus(raw);
}
