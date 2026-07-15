import type { GitStatus, GitStatusEntry } from '@puddle/shared';

/**
 * Pure presentation logic for the explorer's git decorations (SPEC §8) — the
 * tree analogue of the diff view's `diff-status.ts`. Maps a `GitStatus` to its
 * one-letter badge and a semantic colour utility (never a raw colour), builds
 * the path→status lookup the tree overlays, and rolls a folder up to the
 * highest-priority status among its descendants. Monaco/DOM-free and unit-tested.
 */

export interface GitDecoration {
  /** Single-letter badge (U/M/A/D/R/C); empty for `ignored` (dimmed, no badge). */
  letter: string;
  /** A semantic text-colour utility from tokens.css — never a raw hex. */
  colourClass: string;
}

const DECORATIONS: Record<GitStatus, GitDecoration> = {
  untracked: { letter: 'U', colourClass: 'text-running' },
  added: { letter: 'A', colourClass: 'text-running' },
  modified: { letter: 'M', colourClass: 'text-waiting' },
  renamed: { letter: 'R', colourClass: 'text-waiting' },
  deleted: { letter: 'D', colourClass: 'text-interrupted' },
  conflicted: { letter: 'C', colourClass: 'text-interrupted' },
  ignored: { letter: '', colourClass: 'text-fg-muted' },
};

export function gitDecoration(status: GitStatus): GitDecoration {
  return DECORATIONS[status];
}

/** Path → status lookup for O(1) row decoration. */
export function buildStatusMap(entries: readonly GitStatusEntry[]): Map<string, GitStatus> {
  const map = new Map<string, GitStatus>();
  for (const e of entries) map.set(e.path, e.status);
  return map;
}

/**
 * Roll-up rank for a folder tint: the lower the number, the more it dominates.
 * A folder shows the most-significant status among its descendants (conflicts
 * first, ignored last), matching VSCode's folder-colour behaviour.
 */
const ROLLUP_RANK: Record<GitStatus, number> = {
  conflicted: 0,
  modified: 1,
  renamed: 2,
  deleted: 3,
  added: 4,
  untracked: 5,
  ignored: 6,
};

/**
 * The status to tint a folder row with, from every descendant path in `map`.
 * Returns null when the folder has no decorated descendant (a clean folder is
 * un-tinted). `dir` is the folder's worktree-relative path.
 */
export function folderStatus(map: ReadonlyMap<string, GitStatus>, dir: string): GitStatus | null {
  const prefix = dir === '' ? '' : `${dir}/`;
  let best: GitStatus | null = null;
  for (const [path, status] of map) {
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    if (status === 'ignored') continue; // ignored descendants don't tint a folder
    if (best === null || ROLLUP_RANK[status] < ROLLUP_RANK[best]) best = status;
  }
  return best;
}
