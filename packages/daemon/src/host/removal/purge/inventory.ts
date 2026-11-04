import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_PURGE_ANCHORS, type HostPurgeRecord } from '@puddle/shared';
import { purgeDirectoryNames, reviewPurgeWorktrees } from './worktrees.js';

// These are permanent exclusion/recovery records, plus the pinned helper used to
// complete an interrupted purge. Never unlink a live lock's namespace.
const anchors = new Set<string>(HOST_PURGE_ANCHORS);

export async function reviewPurgeData(home: string, requireCurrent: () => void) {
  const roots: HostPurgeRecord['roots'] = purgeDirectoryNames(home, 512)
    .filter((name) => !anchors.has(name))
    .map((name) => {
      const stat = lstatSync(join(home, name));
      if (
        stat.uid !== process.getuid?.() ||
        (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
      )
        throw new Error('Unknown root object blocks purge');
      return {
        name,
        device: stat.dev,
        inode: stat.ino,
        kind: stat.isDirectory()
          ? ('directory' as const)
          : stat.isFile()
            ? ('file' as const)
            : ('symlink' as const),
        state: 'planned' as const,
      };
    });
  const worktrees = await reviewPurgeWorktrees(home, requireCurrent);
  requireCurrent();
  return { roots, worktrees: worktrees.worktrees, worktree_fingerprint: worktrees.fingerprint };
}
