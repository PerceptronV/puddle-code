import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';

/** Retained code remains inspectable, but missing source cannot admit new work. */
export function requireHuddleSource(session: Session) {
  try {
    if (realpathSync(session.worktree_path) !== session.worktree_path)
      throw new Error('Worktree moved');
    let path = session.worktree_path;
    for (const part of ['.puddle', 'huddle', session.huddle_id!, 'huddle.json']) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (part === 'huddle.json' ? !stat.isFile() : !stat.isDirectory()))
        throw new Error('Source changed');
    }
  } catch {
    throw ApiError.conflict(
      'huddle_source_unavailable',
      'Restore the huddle source before admitting new work; inspection and Stop remain available',
    );
  }
}
