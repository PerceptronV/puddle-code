import type { TreeResponse } from '@puddle/shared';

/**
 * Pure, DOM-free helpers for the file explorer (SPEC §8): worktree-relative
 * path arithmetic, the flattened visible-row model that multi-select ranges and
 * arrow-key navigation walk, and the range between two rows. Kept apart from the
 * React provider so it is unit-testable.
 */

export interface VisibleRow {
  /** Worktree-relative path. */
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  /** Indent depth: root children are 0. */
  depth: number;
  /** Parent directory (worktree-relative; '' for a root child). */
  parentDir: string;
}

/** Last path segment. `basename('a/b/c.txt') === 'c.txt'`. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Parent directory, '' for a root-level path. `dirOf('a/b') === 'a'`. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Join a directory and a name into a worktree-relative path. */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** True when `path` is `ancestor` itself or lies inside it — used to forbid moving a folder into its own subtree. */
export function isInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Flatten the loaded-and-expanded tree into an ordered visible-row list.
 * `read(dir)` returns the cached `TreeResponse` for a directory (or undefined
 * if not yet loaded); a directory contributes children only when it is in
 * `expanded` AND its data is present, so a just-expanded folder simply adds no
 * rows until its query resolves.
 */
export function buildVisibleRows(
  read: (dir: string) => TreeResponse | undefined,
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (dir: string, depth: number) => {
    const data = read(dir);
    if (!data) return;
    for (const entry of data.entries) {
      const path = joinPath(dir, entry.name);
      out.push({ path, name: entry.name, type: entry.type, depth, parentDir: dir });
      if (entry.type === 'dir' && expanded.has(path)) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** The inclusive set of paths between two rows in visible order (for shift-click / shift-arrow). */
export function rangeBetween(rows: readonly VisibleRow[], a: string, b: string): string[] {
  const ia = rows.findIndex((r) => r.path === a);
  const ib = rows.findIndex((r) => r.path === b);
  if (ia === -1 || ib === -1) return b ? [b] : [];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return rows.slice(lo, hi + 1).map((r) => r.path);
}
