import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitFixture } from '../../../helpers/huddle/git.js';
import { identifyGitRepository } from '../../../../src/runtime/huddle/triggers/git/read.js';
import { gitWatchDirectories } from '../../../../src/runtime/huddle/triggers/git/watches.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

it('tolerates ref directory pruning during enumeration without hiding root loss or symlink replacement', async () => {
  const f = await gitFixture(),
    signal = new AbortController().signal;
  const identity = await identifyGitRepository(f.definition, signal);
  const disappearing = join(identity.commonDirectory, 'refs/heads/pruned');
  mkdirSync(disappearing);
  const original = fs.opendir;
  const open = vi.spyOn(fs, 'opendir').mockImplementation(async (path) => {
    if (path === disappearing) rmSync(disappearing, { recursive: true });
    return original(path);
  });
  try {
    const watched = await gitWatchDirectories([identity], signal, vi.fn());
    expect(watched.has(disappearing)).toBe(false);
    expect(watched.has(join(identity.commonDirectory, 'refs/heads'))).toBe(true);
    symlinkSync(f.home, join(identity.commonDirectory, 'refs/heads/escape'));
    await expect(gitWatchDirectories([identity], signal, vi.fn())).rejects.toThrow('symlinks');
    rmSync(identity.commonDirectory, { recursive: true });
    await expect(gitWatchDirectories([identity], signal, vi.fn())).rejects.toThrow();
  } finally {
    open.mockRestore();
    f.cleanup();
  }
});
