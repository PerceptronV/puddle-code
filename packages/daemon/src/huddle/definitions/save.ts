import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  HUDDLE_LIMITS,
  huddleTextEditSchema,
  huddleDefinitionSchema,
  type HuddleSave,
  type HuddleTextEdit,
} from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { HuddleDefinitionSnapshot } from './capture.js';

const changed = () =>
  ApiError.conflict(
    'huddle_source_changed',
    'Huddle source changed; reload and reconcile your edits',
  );

/** Resolve every parent without following links, including the worktree itself. */
function directory(worktree: string, id: string) {
  if (realpathSync(worktree) !== worktree) throw changed();
  let root = worktree;
  for (const part of ['.puddle', 'huddle', id]) {
    root = join(root, part);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root)
      throw changed();
  }
  return root;
}

/** Bounded synchronous comparison leaves no daemon task between final checks and rename. */
function matches(root: string, path: string, expected: string): boolean {
  let file = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return false;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > HUDDLE_LIMITS.fileBytes) return false;
    const expectedBytes = Buffer.from(expected);
    if (stat.size !== expectedBytes.length) return false;
    const actual = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < actual.length) {
      const count = readSync(fd, actual, offset, actual.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(file);
    return (
      offset === stat.size &&
      actual.subarray(0, offset).equals(expectedBytes) &&
      after.mtimeMs === stat.mtimeMs &&
      after.ctimeMs === stat.ctimeMs &&
      current.ino === stat.ino &&
      current.dev === stat.dev
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish a single draft file under the repository mutation lock. Source capture
 * and admission happen first. This does not lock editors outside Puddle; detected
 * concurrent edits reject the write, and final comparison/rename has no awaits.
 */
export function saveHuddleDefinition(
  worktree: string,
  snapshot: HuddleDefinitionSnapshot,
  edit: HuddleSave['edit'],
  check: () => void,
): void {
  saveHuddleSource(
    worktree,
    snapshot,
    { file: edit.file, content: `${JSON.stringify(edit.value, null, 2)}\n` },
    check,
  );
}

/** The text contract validates structure while retaining whitespace, key order and Unicode. */
export function saveHuddleSource(
  worktree: string,
  snapshot: HuddleDefinitionSnapshot,
  raw: HuddleTextEdit,
  check: () => void,
): void {
  if (Buffer.byteLength(raw.content) > HUDDLE_LIMITS.fileBytes)
    throw ApiError.badRequest('huddle_file_too_large', 'Huddle source file exceeds its size limit');
  const edit = huddleTextEditSchema.parse(raw);
  if (
    edit.file === 'huddle.json' &&
    huddleDefinitionSchema.parse(JSON.parse(edit.content)).id !== snapshot.definition.id
  )
    throw ApiError.badRequest(
      'huddle_identity_changed',
      'A saved huddle must keep its directory id',
    );
  const text = edit.content;
  const retained = Object.entries(snapshot.files).filter(([path]) => path !== edit.file);
  if (
    retained.length + 1 > HUDDLE_LIMITS.files ||
    retained.reduce(
      (bytes, [, content]) => bytes + Buffer.byteLength(content),
      Buffer.byteLength(text),
    ) > HUDDLE_LIMITS.bundleBytes
  )
    throw ApiError.badRequest(
      'huddle_bundle_too_large',
      'Huddle source bundle exceeds its capture limit',
    );
  const root = directory(worktree, snapshot.definition.id);
  const identity = lstatSync(root);
  const checkSource = () => {
    check();
    if (directory(worktree, snapshot.definition.id) !== root) throw changed();
    const current = lstatSync(root);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw changed();
    for (const [path, content] of Object.entries(snapshot.files)) {
      try {
        if (!matches(root, path, content)) throw changed();
      } catch {
        throw changed();
      }
    }
    if (!Object.hasOwn(snapshot.files, 'layout.json')) {
      try {
        lstatSync(join(root, 'layout.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      throw changed();
    }
  };
  checkSource();
  if (snapshot.files[edit.file] === text) return;
  const target = join(root, edit.file);
  const mode = Object.hasOwn(snapshot.files, edit.file) ? lstatSync(target).mode & 0o777 : 0o644;
  const temporary = join(root, `.puddle-save-${randomBytes(16).toString('hex')}.tmp`);
  // The exclusive sibling file makes a failed write leave the source intact.
  let staged = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    staged = true;
    try {
      // Creation applies the process umask; replacement must retain an existing
      // source file's permissions rather than silently narrowing them.
      if (Object.hasOwn(snapshot.files, edit.file)) fchmodSync(fd, mode);
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    checkSource();
    renameSync(temporary, target);
    staged = false;
    const parent = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (staged) unlinkSync(temporary);
  }
}
