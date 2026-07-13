/**
 * Serialises async work per key. Used with key `repo:<id>` because concurrent
 * `git worktree`/`git fetch` invocations on one repo race on git's own lock
 * files and fail spuriously (SPEC §3). Not reentrant: nesting run() calls for
 * the same key deadlocks — WorktreeManager keeps all repo work single-level.
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
