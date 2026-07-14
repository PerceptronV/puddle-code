/**
 * Pure flat-paths → nested-tree helper for the Changes navigator's uncommitted
 * panel (SPEC §8: "either as a worktree or flat"). Groups changed files by
 * directory, compacting chains of single-child directories into one row
 * (`a/b/c`) the way VS Code does, so a deep change isn't a staircase of
 * one-item folders. DOM-free and side-effect-free — unit-testable.
 */
import type { DiffEntry } from '@puddle/shared';

export interface TreeFileNode {
  type: 'file';
  /** Display name (the basename). */
  name: string;
  /** Full worktree-relative path — the file's identity. */
  path: string;
  entry: DiffEntry;
}

export interface TreeDirNode {
  type: 'dir';
  /** Display name, possibly compacted (`a/b`). */
  name: string;
  /** Full path of this directory (used as a stable expand key). */
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeFileNode | TreeDirNode;

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: TreeFileNode[];
}

function emptyDir(): MutableDir {
  return { dirs: new Map(), files: [] };
}

/** The path a diff entry lives at: its new path (renames show at the destination). */
function entryPath(entry: DiffEntry): string {
  return entry.path;
}

function finalise(dir: MutableDir, prefix: string): TreeNode[] {
  const dirNodes: TreeDirNode[] = [];
  for (const [name, child] of dir.dirs) {
    const path = prefix ? `${prefix}/${name}` : name;
    let node: TreeDirNode = { type: 'dir', name, path, children: finalise(child, path) };
    // Compact a directory that holds exactly one sub-directory and no files
    // into a single `a/b` row (VS Code behaviour).
    while (node.children.length === 1 && node.children[0]!.type === 'dir') {
      const only = node.children[0] as TreeDirNode;
      node = {
        type: 'dir',
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    dirNodes.push(node);
  }
  dirNodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const fileNodes = [...dir.files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  // Directories first, then files (explorer convention).
  return [...dirNodes, ...fileNodes];
}

/** Build a nested, compacted tree from a flat list of diff entries. */
export function buildFileTree(entries: readonly DiffEntry[]): TreeNode[] {
  const root = emptyDir();
  for (const entry of entries) {
    const path = entryPath(entry);
    const segments = path.split('/');
    const fileName = segments.pop()!;
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.dirs.get(seg);
      if (!next) {
        next = emptyDir();
        cursor.dirs.set(seg, next);
      }
      cursor = next;
    }
    cursor.files.push({ type: 'file', name: fileName, path, entry });
  }
  return finalise(root, '');
}

/** Flat list sorted by path — the "flat" toggle state. */
export function flatFileList(entries: readonly DiffEntry[]): TreeFileNode[] {
  return entries
    .map((entry) => ({
      type: 'file' as const,
      name: entryPath(entry).split('/').pop() ?? entryPath(entry),
      path: entryPath(entry),
      entry,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}
