import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Compile on the target macOS host; users of packaged releases need no compiler. */
export function buildHuddleNative(repoRoot, daemonDirectory) {
  if (process.platform !== 'darwin') return;
  const directory = join(daemonDirectory, 'huddle');
  mkdirSync(directory, { recursive: true });
  execFileSync(
    '/usr/bin/xcrun',
    [
      '--sdk',
      'macosx',
      'clang',
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      join(repoRoot, 'packages/daemon/native/huddle/darwin-containment.c'),
      '-o',
      join(directory, 'darwin-containment'),
    ],
    { timeout: 30_000, maxBuffer: 64 * 1024, stdio: 'pipe' },
  );
}
