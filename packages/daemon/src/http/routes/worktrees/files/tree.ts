import { lstat, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TreeEntry } from '@puddle/shared';

/** Ordinary entries need one metadata read; symlinks retain browse-through semantics. */
async function describeEntry(dir: string, name: string): Promise<TreeEntry> {
  const full = join(dir, name);
  const lst = await lstat(full);
  if (!lst.isSymbolicLink())
    return {
      name,
      type: lst.isDirectory() ? 'dir' : 'file',
      size: lst.isDirectory() ? null : lst.size,
      symlink: false,
    };
  try {
    const st = await stat(full);
    if (st.isDirectory()) return { name, type: 'dir', size: null, symlink: true };
    if (st.isFile()) return { name, type: 'file', size: st.size, symlink: true };
  } catch {
    /* Dangling/unreadable links remain visible leaves. */
  }
  return { name, type: 'symlink', size: null, symlink: true };
}

export async function directoryEntries(dir: string, signal: AbortSignal): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  signal.throwIfAborted();
  for await (const entry of await opendir(dir)) {
    signal.throwIfAborted();
    if (entry.name !== '.git') entries.push(await describeEntry(dir, entry.name));
  }
  return entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}
