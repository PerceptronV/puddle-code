import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { git, GitError } from '../../src/git/exec.js';

it('retains an aborted subprocess until it has actually closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'puddle-git-close-'));
  const marker = join(root, 'pid');
  // A controlled git stand-in delays SIGTERM exit; no repository or user process is touched.
  writeFileSync(
    join(root, 'git'),
    `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  const abort = new AbortController();
  const task = git([marker], {
    env: { ...process.env, PATH: root },
    signal: abort.signal,
    timeoutMs: 3000,
  });
  const result = task.then(
    () => null,
    (error: unknown) => error,
  );
  let pid: number | undefined;
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    pid = Number(readFileSync(marker, 'utf8'));
    abort.abort();
    expect(await result).toBeInstanceOf(GitError);
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    await result;
    rmSync(root, { recursive: true, force: true });
  }
});
