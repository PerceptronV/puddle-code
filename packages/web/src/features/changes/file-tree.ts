/**
 * Pure flat-paths → nested-tree helper for the Changes navigator's legacy and
 * repository-aware panels (SPEC §8: "either as a tree or flat"). Groups changed
 * files by directory, compacting chains of single-child directories into one
 * row (`a/b/c`) the way VS Code does, so a deep change isn't a staircase of
 * one-item folders. DOM-free and side-effect-free — unit-testable.
 */
import type { DiffEntry } from '@puddle/shared';

interface PathEntry {
  path: string;
}

export interface TreeFileNode<Entry extends PathEntry = DiffEntry> {
  type: 'file';
  /** Display name (the basename). */
  name: string;
  /** Full worktree-relative path — the file's identity. */
  path: string;
  entry: Entry;
}

export interface TreeDirNode<Entry extends PathEntry = DiffEntry> {
  type: 'dir';
  /** Display name, possibly compacted (`a/b`). */
  name: string;
  /** Full path of this directory (used as a stable expand key). */
  path: string;
  children: TreeNode<Entry>[];
}

export type TreeNode<Entry extends PathEntry = DiffEntry> =
  TreeFileNode<Entry> | TreeDirNode<Entry>;

interface MutableDir<Entry extends PathEntry> {
  dirs: Map<string, MutableDir<Entry>>;
  files: TreeFileNode<Entry>[];
}

function emptyDir<Entry extends PathEntry>(): MutableDir<Entry> {
  return { dirs: new Map(), files: [] };
}

/** The path a diff entry lives at: its new path (renames show at the destination). */
function entryPath(entry: PathEntry): string {
  return entry.path;
}

function finalise<Entry extends PathEntry>(
  dir: MutableDir<Entry>,
  prefix: string,
): TreeNode<Entry>[] {
  const dirNodes: TreeDirNode<Entry>[] = [];
  for (const [name, child] of dir.dirs) {
    const path = prefix ? `${prefix}/${name}` : name;
    let node: TreeDirNode<Entry> = {
      type: 'dir',
      name,
      path,
      children: finalise(child, path),
    };
    // Compact a directory that holds exactly one sub-directory and no files
    // into a single `a/b` row (VS Code behaviour).
    while (node.children.length === 1 && node.children[0]!.type === 'dir') {
      const only = node.children[0] as TreeDirNode<Entry>;
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
export function buildFileTree<Entry extends PathEntry>(
  entries: readonly Entry[],
): TreeNode<Entry>[] {
  const root = emptyDir<Entry>();
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
export function flatFileList<Entry extends PathEntry>(
  entries: readonly Entry[],
): TreeFileNode<Entry>[] {
  return entries
    .map((entry) => ({
      type: 'file' as const,
      name: entryPath(entry).split('/').pop() ?? entryPath(entry),
      path: entryPath(entry),
      entry,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
}

/** Every file entry represented below a file or directory node. */
export function treeEntries<Entry extends PathEntry>(node: TreeNode<Entry>): Entry[] {
  if (node.type === 'file') return [node.entry];
  return node.children.flatMap(treeEntries);
}
