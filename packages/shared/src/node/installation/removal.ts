import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { privatePath } from '../security.js';

/** Passive fence: even a malformed or linked active record requires explicit removal recovery. */
export function requireNoHostRemoval(home: string): void {
  for (const directory of ['installation', 'installation/removal']) {
    try {
      privatePath(join(home, directory), true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  try {
    lstatSync(join(home, 'installation/removal/services.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'Resolve the recorded host removal before starting or updating this installation',
  );
}
