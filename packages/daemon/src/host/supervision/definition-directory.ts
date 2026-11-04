import { closeSync, constants, fstatSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** User service directories may be 0755; they must still be owned and never externally writable. */
export function openServiceDefinitionDirectory(file: string): number {
  const parent = openSync(
    dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(parent);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new Error('Unsafe service definition directory');
    return parent;
  } catch (error) {
    closeSync(parent);
    throw error;
  }
}

export function syncServiceDefinitionDirectory(file: string): void {
  const parent = openServiceDefinitionDirectory(file);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
