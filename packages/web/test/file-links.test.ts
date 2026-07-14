import { describe, expect, it, vi } from 'vitest';
import type { ResolvePathResponse } from '@puddle/shared';
import { findPathCandidates, ResolveCache } from '../src/features/terminal/file-links';

describe('findPathCandidates', () => {
  it('captures a path with line and column, underlining the whole token', () => {
    expect(findPathCandidates('src/foo.ts:12:3')).toEqual([
      { path: 'src/foo.ts', line: 12, column: 3, start: 0, end: 15 },
    ]);
  });

  it('captures a ./relative path with no position', () => {
    expect(findPathCandidates('./a/b.py')).toEqual([
      { path: './a/b.py', line: undefined, column: undefined, start: 0, end: 8 },
    ]);
  });

  it('captures a ../relative path with a line only', () => {
    expect(findPathCandidates('../x/y.rs:7')).toEqual([
      { path: '../x/y.rs', line: 7, column: undefined, start: 0, end: 11 },
    ]);
  });

  it('captures an absolute path mid-sentence', () => {
    expect(findPathCandidates('open /wt/src/a.c now')).toEqual([
      { path: '/wt/src/a.c', line: undefined, column: undefined, start: 5, end: 16 },
    ]);
  });

  it('captures a path inside double quotes without the quotes', () => {
    expect(findPathCandidates('he said "src/foo.ts" ok')).toEqual([
      { path: 'src/foo.ts', line: undefined, column: undefined, start: 9, end: 19 },
    ]);
  });

  it('captures a path:line inside parens, leaving the closing paren out', () => {
    expect(findPathCandidates('(src/foo.ts:3)')).toEqual([
      { path: 'src/foo.ts', line: 3, column: undefined, start: 1, end: 13 },
    ]);
  });

  it('drops a trailing sentence full stop', () => {
    expect(findPathCandidates('see src/foo.ts. end')).toEqual([
      { path: 'src/foo.ts', line: undefined, column: undefined, start: 4, end: 14 },
    ]);
  });

  it('finds several candidates on one line', () => {
    expect(findPathCandidates('a.ts b.ts two')).toEqual([
      { path: 'a.ts', line: undefined, column: undefined, start: 0, end: 4 },
      { path: 'b.ts', line: undefined, column: undefined, start: 5, end: 9 },
    ]);
  });

  it('matches a bare filename because it carries an extension', () => {
    expect(findPathCandidates('bare foo.ts here')).toEqual([
      { path: 'foo.ts', line: undefined, column: undefined, start: 5, end: 11 },
    ]);
  });

  it('ignores an extension-less word but keeps a real filename beside it', () => {
    // LICENSE has no extension and no leading slash → quiet; README.md matches.
    expect(findPathCandidates('README.md and LICENSE')).toEqual([
      { path: 'README.md', line: undefined, column: undefined, start: 0, end: 9 },
    ]);
  });

  it('stays quiet for prose and decimal numbers', () => {
    expect(findPathCandidates('the value 3.14 is fine')).toEqual([]);
    expect(findPathCandidates('just some prose words')).toEqual([]);
  });

  it('produces a benign false positive for "e.g." that the server then rejects', () => {
    // ".g" is a legal one-letter extension (cf. .c, .h, .R); the regex cannot
    // tell it from prose, so a candidate is emitted and /resolve 404s it away.
    expect(findPathCandidates('e.g. this way')).toEqual([
      { path: 'e.g', line: undefined, column: undefined, start: 0, end: 3 },
    ]);
  });
});

/** A deferred promise for driving fetcher timing in tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (path: string): ResolvePathResponse => ({ path, line: null });

describe('ResolveCache', () => {
  it('serves a positive result from cache until its 15s TTL lapses', async () => {
    let t = 0;
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => t });

    await cache.resolve('s', 'a.ts');
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 14_999;
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 15_001;
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ages a negative result out after only 5s', async () => {
    let t = 0;
    const fetcher = vi.fn(async () => null);
    const cache = new ResolveCache({ fetcher, now: () => t });

    expect(await cache.resolve('s', 'x.ts')).toBeNull();
    t = 4_999;
    await cache.resolve('s', 'x.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 5_001;
    await cache.resolve('s', 'x.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent asks for the same key into a single fetch', async () => {
    const d = deferred<ResolvePathResponse>();
    const fetcher = vi.fn(() => d.promise);
    const cache = new ResolveCache({ fetcher, now: () => 0 });

    const p1 = cache.resolve('s', 'a.ts');
    const p2 = cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    d.resolve(ok('a.ts'));
    expect(await p1).toEqual(ok('a.ts'));
    expect(await p2).toEqual(ok('a.ts'));
  });

  it('keys on (session, path) so different sessions do not collide', async () => {
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => 0 });
    await cache.resolve('s1', 'a.ts');
    await cache.resolve('s2', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry once the cap is exceeded', async () => {
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => 0, maxEntries: 2 });

    await cache.resolve('s', 'a.ts'); // oldest
    await cache.resolve('s', 'b.ts');
    await cache.resolve('s', 'c.ts'); // evicts a.ts
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cache.resolve('s', 'b.ts'); // still warm
    await cache.resolve('s', 'c.ts'); // still warm
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cache.resolve('s', 'a.ts'); // re-fetched, it was evicted
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('never runs more than maxConcurrent fetches at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    const fetcher = vi.fn((_s: string, path: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<ResolvePathResponse>((res) => {
        releasers.push(() => {
          inFlight--;
          res(ok(path));
        });
      });
    });
    const cache = new ResolveCache({ fetcher, now: () => 0, maxConcurrent: 4 });

    const asks = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => cache.resolve('s', `${n}.ts`));
    // Four slots fill synchronously; the last two queue behind the semaphore.
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(peak).toBe(4);

    // Drain: release one at a time, yielding so a queued fetch can take the slot.
    let settled = false;
    void Promise.all(asks).then(() => {
      settled = true;
    });
    for (let guard = 0; !settled && guard < 100; guard++) {
      await Promise.resolve();
      releasers.shift()?.();
    }

    await Promise.all(asks);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(peak).toBe(4);
  });
});
