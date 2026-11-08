import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Explicit canonical resource root; never follow a declared relative directory through symlinks. */
export function requireTriggerDirectory(worktree: string, directory: string) {
  if (!isAbsolute(worktree) || realpathSync(worktree) !== worktree)
    throw new Error('Trigger worktree moved from its canonical root');
  let path = worktree;
  for (const part of directory === '.' ? [] : directory.replace(/^\.\//, '').split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid trigger directory');
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink())
      throw new Error('Trigger directory cannot follow a symlink');
  }
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error('Trigger directory is unavailable or moved');
  return path;
}
