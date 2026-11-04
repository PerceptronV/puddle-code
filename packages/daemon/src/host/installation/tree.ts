import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

export const OWNED_TREE_FILE_BUDGET = 512;

/** Removing links never follows them. Mounted, replaced or unknown objects remain untouched. */
export async function pruneOwnedTree(
  root: string,
  identity: { device: number; inode: number },
  requireCurrent: () => void,
  budget: { remaining: number },
  options: { allowSockets?: boolean } = {},
): Promise<boolean> {
  if (
    !Number.isSafeInteger(budget.remaining) ||
    budget.remaining < 0 ||
    budget.remaining > OWNED_TREE_FILE_BUDGET
  )
    throw new Error('Invalid owned-tree deletion budget');
  const ancestors: Array<{ path: string; device: number; inode: number }> = [];
  const inspect = (path: string) => {
    const info = lstatSync(path);
    if (info.uid !== process.getuid?.() || info.dev !== identity.device)
      throw new Error('Collection tree ownership or device changed');
    return info;
  };
  const requireAncestors = () => {
    requireCurrent();
    for (const ancestor of ancestors) {
      const info = inspect(ancestor.path);
      if (!info.isDirectory() || info.ino !== ancestor.inode || (info.mode & 0o022) !== 0)
        throw new Error('Collection directory identity changed');
    }
  };
  const visit = async (path: string, depth: number): Promise<boolean> => {
    requireAncestors();
    if (depth > 64) throw new Error('Collection tree exceeds its depth limit');
    const info = inspect(path);
    if (!info.isDirectory() || (depth === 0 && info.ino !== identity.inode))
      throw new Error('Collection root identity changed');
    ancestors.push({ path, device: info.dev, inode: info.ino });
    try {
      for await (const entry of await opendir(path)) {
        requireAncestors();
        if (budget.remaining === 0) return false;
        const child = join(path, entry.name);
        const current = inspect(child);
        if (current.isDirectory()) {
          if (!(await visit(child, depth + 1))) return false;
        } else {
          if (
            !current.isFile() &&
            !current.isSymbolicLink() &&
            !(options.allowSockets && current.isSocket())
          )
            throw new Error('Unknown object in collection tree');
          requireAncestors();
          unlinkSync(child);
          budget.remaining--;
        }
      }
      requireAncestors();
      if (budget.remaining === 0) return false;
      syncOwnedDirectory(path);
    } finally {
      ancestors.pop();
    }
    requireAncestors();
    rmdirSync(path);
    budget.remaining--;
    return true;
  };
  return visit(root, 0);
}

/** Published release directories need not be mode 0700, but must be owned and non-writable. */
export function syncOwnedDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new Error('Unsafe owned directory');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
