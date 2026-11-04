import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { digest, initialisePrivateHome, privateDirectory, privatePath } from '@puddle/shared/node';

export class RuntimeClaimBusy extends Error {
  constructor() {
    super('Another live process owns this runtime claim');
    this.name = 'RuntimeClaimBusy';
  }
}

/**
 * SQLite's OS file lock gives us process-lifetime exclusion on macOS and Linux
 * without pidfiles, heartbeat expiry or another native dependency. These empty
 * databases contain no application state and are never unlinked: replacing a
 * locked inode would let two owners hold different locks for the same claim.
 */
export function acquireRuntimeClaim(home: string, scope: string): { release(): void } {
  initialisePrivateHome(home);
  const directory = join(home, 'runtime-claims');
  privateDirectory(directory);
  const file = join(directory, `${digest(scope)}.sqlite`);
  try {
    closeSync(
      openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  privatePath(file);
  const db = new Database(file, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') throw new RuntimeClaimBusy();
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    },
  };
}
