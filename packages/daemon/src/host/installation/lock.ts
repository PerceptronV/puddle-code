import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { initialisePrivateHome, privateDirectory } from '@puddle/shared/node';

/**
 * Share scripts/install.sh's permanent inode and inherited flock. Never unlink it:
 * old installers must still fail their mkdir, and live descendants retain exclusion.
 */
export function acquireInstallationLock(home: string) {
  initialisePrivateHome(home);
  privateDirectory(join(home, 'bin'));
  let descriptor: number;
  try {
    descriptor = openSync(
      join(home, 'bin/.install-lock'),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR')
      throw new Error(
        'A legacy installation lock needs inspection; its owner cannot be established',
        { cause: error },
      );
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size !== 0
    )
      throw new Error('Unsafe installation lock');
    const hostPlatform = platform();
    const darwin = hostPlatform === 'darwin';
    if (!darwin && hostPlatform !== 'linux') throw new Error('Unsupported installation locking');
    // The helper locks a duplicate of our open file description. Its exit does not
    // release our reference. Closing all inherited references releases after a crash.
    execFileSync(
      darwin ? '/usr/bin/perl' : 'flock',
      darwin
        ? [
            '-e',
            'use Fcntl qw(LOCK_EX LOCK_NB); open(my $lock, ">&=$ARGV[0]") or exit 74; flock($lock, LOCK_EX|LOCK_NB) or exit 75;',
            '3',
          ]
        : ['-E', '75', '-n', '3'],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['ignore', 'ignore', 'pipe', descriptor],
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
  } catch (error) {
    closeSync(descriptor);
    if ((error as { status?: number }).status === 75)
      throw new Error('Another installer or its child is running', { cause: error });
    throw error;
  }
  let released = false;
  return {
    descriptor,
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
    },
  };
}
