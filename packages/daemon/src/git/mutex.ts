import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git } from './exec.js';

/** Canonical lock domain shared by a repository and every linked worktree. */
export async function gitMutexKey(cwd: string): Promise<string> {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
  }).catch(() => git(['rev-parse', '--git-common-dir'], { cwd }));
  const absolute = resolve(cwd, common);
  try {
    return `git:${await realpath(absolute)}`;
  } catch {
    return `git:${absolute}`;
  }
}

/**
 * Serialises async work per key. Used with `gitMutexKey` because concurrent
 * Git writes sharing a common directory race on Git's lock files and fail
 * spuriously (SPEC §3). Not reentrant: nesting run() calls for the same key
 * deadlocks — WorktreeManager keeps all repo work single-level.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run regardless of the predecessor's fate
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
