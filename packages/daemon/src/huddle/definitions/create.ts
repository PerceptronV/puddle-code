import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { huddleDefinitionSchema } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';

/** Small synchronous publication: no await between final authority check and writes. */
export function createHuddleDefinition(worktree: string, name: string) {
  if (realpathSync(worktree) !== worktree)
    throw ApiError.conflict('huddle_worktree_changed', 'Huddle worktree changed');
  let directory = worktree;
  for (const part of ['.puddle', 'huddle']) {
    directory = join(directory, part);
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory() || realpathSync(directory) !== directory)
      throw ApiError.conflict(
        'huddle_collection_invalid',
        'Huddle collection must contain ordinary directories',
      );
  }
  const id = randomBytes(16).toString('hex');
  const definition = huddleDefinitionSchema.parse({ format: 1, id, name, nodes: [], edges: [] });
  // Exclusive mkdir never replaces an existing definition, even on an id collision.
  const root = join(directory, id);
  mkdirSync(root);
  writeFileSync(join(root, 'huddle.json'), `${JSON.stringify(definition, null, 2)}\n`, {
    flag: 'wx',
    flush: true,
  });
  // A later placement failure retains this source for explicit discovery/open.
  return definition;
}
