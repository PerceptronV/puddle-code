import { lstatSync } from 'node:fs';

/** Legacy databases may be readable; their containing Puddle home must be private. */
export function requireOwnedDatabase(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new Error('Unsafe application database during host maintenance');
}
