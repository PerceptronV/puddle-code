import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { HUDDLE_GIT_LIMITS } from '@puddle/shared';
import type { GitRepositoryIdentity } from './read.js';

/** Watch only ref metadata, never the object store, reflogs or working-file tree. */
export async function gitWatchDirectories(
  repositories: GitRepositoryIdentity[],
  signal: AbortSignal,
  attach: (path: string, identity: string, allNames: boolean) => void,
) {
  const seen = new Set<string>();
  let entries = 0;
  async function visit(path: string, recursive: boolean, optional = false) {
    try {
      await readDirectory(path, recursive);
    } catch (error) {
      // Git may prune a loose-ref directory between enumeration and watch attachment.
      // The parent watch and the following Git read still reconcile its net state.
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        seen.delete(path);
        return;
      }
      throw error;
    }
  }
  async function readDirectory(path: string, recursive: boolean) {
    signal.throwIfAborted();
    if (seen.has(path)) return;
    const stat = await lstat(path, { bigint: true });
    signal.throwIfAborted();
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Git metadata directory was replaced');
    seen.add(path);
    if (seen.size > HUDDLE_GIT_LIMITS.directories)
      throw new Error('Git observation exceeds 128 directories');
    attach(path, `${stat.dev}:${stat.ino}`, recursive);
    if (!recursive) return;
    const directory = await opendir(path);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++entries > HUDDLE_GIT_LIMITS.entries)
        throw new Error('Git observation exceeds 8192 metadata entries');
      if (entry.isDirectory()) await visit(join(path, entry.name), true, true);
      else if (entry.isSymbolicLink())
        throw new Error('Git ref metadata must not contain symlinks');
    }
  }
  for (const repository of repositories) {
    await visit(repository.repository, false);
    await visit(repository.gitDirectory, false);
    await visit(repository.commonDirectory, false);
    await visit(join(repository.commonDirectory, 'refs'), true, true);
    await visit(join(repository.commonDirectory, 'reftable'), true, true);
    if (repository.gitDirectory !== repository.commonDirectory)
      await visit(join(repository.gitDirectory, 'refs'), true, true);
  }
  return seen;
}

export function gitMetadataName(name: string | null) {
  return (
    name === null ||
    [
      '.git',
      'HEAD',
      'refs',
      'packed-refs',
      'reftable',
      'commondir',
      'gitdir',
      'config',
      'config.worktree',
    ].includes(name)
  );
}
