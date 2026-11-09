import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { huddleTemplateFiles, HUDDLE_LIMITS, type HuddleInstallTemplate } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';

/** Materialise a source component only; graph edits and activation are separate actions. */
export function installHuddleTemplate(
  worktree: string,
  input: HuddleInstallTemplate,
  check: () => void,
) {
  let root = worktree;
  const directory = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
      throw ApiError.conflict('huddle_source_changed', 'Huddle component directory changed');
  };
  directory(root);
  for (const part of ['.puddle', 'huddle', input.huddle_id]) {
    root = join(root, part);
    directory(root);
  }
  const { component, files } = huddleTemplateFiles(input.template, input.builtin);
  check();
  const nodes = join(root, 'nodes');
  try {
    mkdirSync(nodes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  directory(nodes);
  const target = join(nodes, input.component);
  try {
    mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  directory(target);
  // Inspect every existing file before filling a partial, identical installation.
  // Exclusive creation never overwrites user-edited source or a replacement link.
  const missing: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    let fd: number;
    try {
      fd = openSync(
        join(target, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push(name);
        continue;
      }
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      const expected = Buffer.from(text);
      const actual = Buffer.alloc(expected.length + 1);
      if (
        !stat.isFile() ||
        stat.size > HUDDLE_LIMITS.fileBytes ||
        readSync(fd, actual, 0, actual.length, 0) !== expected.length ||
        !actual.subarray(0, expected.length).equals(expected)
      )
        throw ApiError.conflict(
          'huddle_component_exists',
          'This component contains different source; choose a new component name',
        );
    } finally {
      closeSync(fd);
    }
  }
  check();
  directory(root);
  directory(nodes);
  directory(target);
  for (const name of missing)
    writeFileSync(join(target, name), files[name as keyof typeof files], {
      flag: 'wx',
      flush: true,
    });
  return { manifest: `nodes/${input.component}/node.json`, component };
}
