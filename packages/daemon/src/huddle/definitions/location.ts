import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only presence check shared by controller admission and autonomous triggers. */
export function requireHuddleDefinitionLocation(worktree: string, id: string) {
  if (realpathSync(worktree) !== worktree) throw new Error('Huddle worktree moved');
  let path = worktree;
  for (const part of ['.puddle', 'huddle', id, 'huddle.json']) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (part === 'huddle.json' ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('Huddle source location changed');
  }
}
