import type {
  IBuffer,
  IBufferCellPosition,
  IDisposable,
  ILink,
  Terminal as XTerm,
} from '@xterm/xterm';
import type { ResolvePathResponse } from '@puddle/shared';
import { api } from '../../lib/api';

/**
 * Validated file-path links for session terminals (SPEC §7). xterm's built-in
 * links only handle URLs (that is the web-links addon's job); this provider
 * underlines paths an agent prints — `src/foo.ts:12:3`, `./a/b.py`,
 * `/wt/main.c` — but ONLY after the daemon confirms the file exists, so prose
 * that merely looks path-shaped never lights up. Cmd/Ctrl+click opens it in the
 * Monaco editor at the given position; a plain click keeps terminal selection.
 *
 * Kept out of `Terminal.tsx` for the same reason as `paste-image.ts`: terminal
 * integrations are separate modules, not inline mount-effect noise. Never
 * registered for `login-*` streams — those have no worktree to resolve against.
 */

/** One path-shaped token found in a line, with offsets into the logical text. */
export interface PathCandidate {
  path: string;
  line?: number;
  column?: number;
  /** Inclusive start offset in the assembled logical line. */
  start: number;
  /** Exclusive end offset — the underline spans `[start, end)`. */
  end: number;
}

// Permissive by design: the daemon's /resolve endpoint is the real validator, so
// a false positive here costs nothing (it just never underlines). A candidate is
// path-shaped when it (a) has a path prefix — `/`, `~/`, `./`, `../` — and a
// segment, (b) contains a `/` (a multi-segment relative path like
// `.worktrees/hil-demos`), or (c) is a bare filename WITH an extension (`foo.ts`);
// so extensionless dirs and files with path structure light up while plain prose
// and decimals like `3.14` stay quiet. The `d` flag gives per-group indices so we
// can bracket exactly the path (and any `:line:col`) without re-scanning.
const PATH_RE =
  /(?:^|[\s"'`([<])((?:(?:\/|\.{1,2}\/|~\/)(?:[\w.+@~-]+\/)*[\w.+@~-]+|(?:[\w.+@~-]+\/)+[\w.+@~-]*|[\w.+@~-]+\.[A-Za-z]\w{0,11}))(?::(\d{1,6})(?::(\d{1,6}))?)?/dg;

const TRAILING_PUNCT = new Set(['.', ',', ';', ':', ')', ']', "'", '"']);

/**
 * Extracts every path-shaped candidate from one logical terminal line. Pure and
 * exported for unit tests. Offsets are into `text` so a caller can translate
 * them back to per-row buffer coordinates.
 */
export function findPathCandidates(text: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  const re = new RegExp(PATH_RE.source, PATH_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const indices = m.indices;
    const captured = m[1];
    if (!indices?.[1] || captured === undefined) continue;
    let pathStart = indices[1][0];
    let pathEnd = indices[1][1];
    let path = captured;
    // Claude Code prints file references as `@path` (`@~/notes.md`); the `@` is
    // not part of the path, so drop it and move the underline start past it.
    if (path.startsWith('@')) {
      path = path.slice(1);
      pathStart++;
    }
    // Defensive: strip trailing punctuation the regex already excludes, so a
    // future tweak to the character class cannot start underlining a stray `)`.
    while (path.length > 0 && TRAILING_PUNCT.has(path[path.length - 1]!)) {
      path = path.slice(0, -1);
      pathEnd--;
    }
    if (path.length === 0) continue;

    const line = m[2] !== undefined ? Number.parseInt(m[2], 10) : undefined;
    const column = m[3] !== undefined ? Number.parseInt(m[3], 10) : undefined;
    // Underline the whole `path:line:col` token, not just the path.
    const end =
      column !== undefined && indices[3]
        ? indices[3][1]
        : line !== undefined && indices[2]
          ? indices[2][1]
          : pathEnd;

    out.push({ path, line, column, start: pathStart, end });
    // A zero-width guard is unnecessary — every match consumes a non-empty path.
  }
  return out;
}

type Fetcher = (
  sessionId: string,
  path: string,
  line?: number,
) => Promise<ResolvePathResponse | null>;

export interface ResolveCacheOptions {
  fetcher: Fetcher;
  now?: () => number;
  /** How long a 200 stays trusted (default 15s). */
  positiveTtlMs?: number;
  /** How long a 404 stays trusted — short, agents create files mid-session (default 5s). */
  negativeTtlMs?: number;
  /** Oldest-first eviction cap (default 500). */
  maxEntries?: number;
  /** Ceiling on simultaneous in-flight fetches (default 4). */
  maxConcurrent?: number;
}

interface CacheEntry {
  value: ResolvePathResponse | null;
  expiresAt: number;
}

/**
 * Caches `/resolve` answers so hovering a wall of paths cannot hammer the
 * daemon: positive/negative TTLs, in-flight de-duplication, an oldest-first cap,
 * and a concurrency semaphore. Keyed on `(sessionId, path)` — the requested
 * line does not change whether the file exists, so it is not part of the key.
 * The clock and fetcher are injected so the whole thing is unit-testable.
 */
export class ResolveCache {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxConcurrent: number;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResolvePathResponse | null>>();
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: ResolveCacheOptions) {
    this.fetcher = opts.fetcher;
    this.now = opts.now ?? Date.now;
    this.positiveTtlMs = opts.positiveTtlMs ?? 15_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
  }

  resolve(sessionId: string, path: string, line?: number): Promise<ResolvePathResponse | null> {
    const key = `${sessionId}\0${path}`;

    const entry = this.entries.get(key);
    if (entry) {
      if (this.now() < entry.expiresAt) return Promise.resolve(entry.value);
      this.entries.delete(key); // expired
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.withSlot(() => this.fetcher(sessionId, path, line))
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private store(key: string, value: ResolvePathResponse | null): void {
    const ttl = value ? this.positiveTtlMs : this.negativeTtlMs;
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value; // insertion order
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Runs `fn` under the concurrency ceiling, releasing the slot when it settles. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inUse >= this.maxConcurrent) {
      await new Promise<void>((release) => this.waiters.push(release));
    }
    this.inUse++;
    try {
      return await fn();
    } finally {
      this.inUse--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Assembles the full logical line that buffer row `row0` (0-based) belongs to,
 * following xterm's soft wrapping: walk back while the current row is a
 * continuation, then forward while the next row is. Returns the per-row strings
 * (concatenate for matching) and the 0-based index of the first row, so match
 * offsets can be mapped back to cells. Bounded so a pathological line cannot
 * scan the entire scrollback.
 */
function assembleLogicalLine(buffer: IBuffer, row0: number): { text: string; startRow: number } {
  const MAX_LEN = 2048;
  let startRow = row0;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow--;

  let text = '';
  for (let y = startRow; ; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y !== startRow && !line.isWrapped) break; // next logical line begins
    text += line.translateToString(true);
    if (text.length > MAX_LEN) break;
  }
  return { text, startRow };
}

/**
 * Maps a character offset in the assembled logical line back to a 0-based
 * (row, col) buffer cell, starting the walk from (`row`, `col`). Accounts for
 * wide (CJK) cells that occupy two columns but one string character, and for a
 * wide glyph pushed onto the next wrapped row. Returns null if the offset runs
 * off the end of the buffer. Mirrors the technique in `@xterm/addon-web-links`.
 */
function offsetToCell(
  buffer: IBuffer,
  row: number,
  col: number,
  offset: number,
): { row: number; col: number } | null {
  const cell = buffer.getNullCell();
  let y = row;
  let x = col;
  let remaining = offset;
  while (remaining >= 0) {
    const line = buffer.getLine(y);
    if (!line) return null;
    for (; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth()) {
        remaining -= cell.getChars().length || 1;
        if (x === line.length - 1 && cell.getChars() === '') {
          // A wide glyph that did not fit was carried to the next wrapped row.
          const next = buffer.getLine(y + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return { row: y, col: x };
    }
    y++;
    x = 0;
  }
  return { row: y, col: x };
}

/** The live `/resolve` fetcher: 200 → the normalised response, anything else → null. */
async function resolvePath(
  sessionId: string,
  path: string,
  line?: number,
): Promise<ResolvePathResponse | null> {
  const query = new URLSearchParams({ path });
  if (line !== undefined) query.set('line', String(line));
  try {
    return await api<ResolvePathResponse>('GET', `/api/worktrees/${sessionId}/resolve?${query}`);
  } catch {
    // 404 (not found / escape attempt) and transient errors both mean "don't
    // underline". Fail safe rather than surfacing anything to the user.
    return null;
  }
}

/**
 * Registers the validated file-path link provider on `xterm`. `onOpen` receives
 * the daemon's normalised worktree-relative path (never the raw match) plus the
 * requested line/column. Returns an `IDisposable` to unregister on unmount.
 */
export function registerFileLinks(
  xterm: XTerm,
  sessionId: string,
  onOpen: (path: string, line?: number, column?: number) => void,
): IDisposable {
  const cache = new ResolveCache({ fetcher: resolvePath });

  return xterm.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = xterm.buffer.active;
      // xterm hands provideLinks a 1-based buffer line; assemble from 0-based.
      const { text, startRow } = assembleLogicalLine(buffer, bufferLineNumber - 1);
      const candidates = findPathCandidates(text);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void Promise.all(
        candidates.map(async (candidate): Promise<ILink | null> => {
          const resolved = await cache.resolve(sessionId, candidate.path, candidate.line);
          if (!resolved) return null;
          const start = offsetToCell(buffer, startRow, 0, candidate.start);
          const end = offsetToCell(
            buffer,
            start?.row ?? startRow,
            start?.col ?? 0,
            candidate.end - candidate.start,
          );
          if (!start || !end) return null;
          return {
            // Positions are 1-based; `end.col` already sits one past the last
            // cell of the token, so it is used verbatim (not +1).
            range: {
              start: { x: start.col + 1, y: start.row + 1 },
              end: { x: end.col, y: end.row + 1 },
            } satisfies { start: IBufferCellPosition; end: IBufferCellPosition },
            text: text.slice(candidate.start, candidate.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => {
              // SPEC §14 activation gesture is cmd/ctrl+click; a plain click
              // must keep the terminal's own text selection.
              if (!event.metaKey && !event.ctrlKey) return;
              onOpen(
                resolved.path,
                candidate.line !== undefined ? Math.max(1, candidate.line) : undefined,
                candidate.column,
              );
            },
          };
        }),
      ).then((links) => {
        const valid = links.filter((link): link is ILink => link !== null);
        callback(valid.length > 0 ? valid : undefined);
      });
    },
  });
}
