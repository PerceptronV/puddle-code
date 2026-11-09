import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { huddleDefinitionSchema, huddleStarterFiles, type HuddleStarter } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';

/** Small synchronous publication: no await between final authority check and writes. */
export function createHuddleDirectory(worktree: string) {
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
  // Exclusive mkdir never replaces an existing definition, even on an id collision.
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomBytes(16).toString('hex');
    const root = join(directory, id);
    try {
      mkdirSync(root);
      return { id, root };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a new huddle directory');
}

export function createHuddleDefinition(worktree: string, name: string, template?: HuddleStarter) {
  const { id, root } = createHuddleDirectory(worktree);
  if (template) {
    const starter = huddleStarterFiles(template, id, name, worktree);
    for (const [path, text] of Object.entries(starter.files)) {
      if (path === 'huddle.json') continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text, { flag: 'wx', flush: true });
    }
    writeFileSync(join(root, 'huddle.json'), starter.files['huddle.json']!, {
      flag: 'wx',
      flush: true,
    });
    return starter.definition;
  }
  const definition = huddleDefinitionSchema.parse({ format: 1, id, name, nodes: [], edges: [] });
  writeFileSync(join(root, 'huddle.json'), `${JSON.stringify(definition, null, 2)}\n`, {
    flag: 'wx',
    flush: true,
  });
  // A later placement failure retains this source for explicit discovery/open.
  return definition;
}
