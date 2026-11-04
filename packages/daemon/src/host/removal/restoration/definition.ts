import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { writeServiceDefinition } from '../../services.js';
import { openServiceDefinitionDirectory } from '../../supervision/definition-directory.js';
import { syncOwnedDirectory } from '../../installation/tree.js';

/** Only the already-validated installed user path may be recreated after its empty parents vanish. */
function ensureRestorationDirectory(file: string, root: string): void {
  const parts = relative(root, dirname(file)).split(sep).filter(Boolean);
  if (parts.includes('..')) throw new Error('Restoration directory is outside its user home');
  let parent = root;
  for (const part of ['', ...parts]) {
    const path = part ? join(parent, part) : root;
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
        throw new Error('Unsafe restoration directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !part) throw error;
      mkdirSync(path, { mode: 0o700 });
      syncOwnedDirectory(parent);
    }
    parent = path;
  }
}

/** Observation after a lost publication reply must also establish durable file/entry writes. */
export function syncRestoredServiceDefinition(file: string): void {
  const parent = openServiceDefinitionDirectory(file);
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0 ||
        info.nlink !== 1 ||
        info.size > 64 * 1024
      )
        throw new Error('Unsafe restored service definition');
      fsyncSync(fd);
      fsyncSync(parent);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parent);
  }
}

/** Publish complete bytes without overwriting a concurrently created unit/plist. */
export function restoreServiceDefinition(file: string, source: string, userHome?: string): void {
  if (userHome) ensureRestorationDirectory(file, userHome);
  const parent = openServiceDefinitionDirectory(file);
  try {
    const temporary = `${file}.${randomUUID()}.restore`;
    // The private temporary file is complete and synced before the destination appears.
    writeServiceDefinition(temporary, Buffer.from(source, 'base64'));
    const written = lstatSync(temporary);
    const clean = () => {
      const current = lstatSync(temporary);
      if (current.dev !== written.dev || current.ino !== written.ino)
        throw new Error('Restoration temporary file changed');
      unlinkSync(temporary);
      fsyncSync(parent);
    };
    try {
      linkSync(temporary, file); // Atomic no-replace publication on the same filesystem.
    } finally {
      clean();
    }
  } finally {
    closeSync(parent);
  }
}
