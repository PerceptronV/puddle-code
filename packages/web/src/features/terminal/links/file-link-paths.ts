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

// A space inside a directory component is unambiguous once followed by `/`.
// Keep single spaces between words; terminal padding must not become a path.
const SPACED_DIRECTORY_RE =
  /(?:^|[\s"'`([<])((?:~?\/|\.{1,2}\/|[\w.+@~-]+\/)(?:[\w.+@~-]+(?: [\w.+@~-]+)*\/)*[\w.+@~-]+)(?::(\d{1,6})(?::(\d{1,6}))?)?/dg;

// Enclosures give filenames containing spaces a definite end, including an
// optional position inside the enclosure. The ordinary tokens remain fallbacks.
const ENCLOSED_PATH_RE =
  /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|\(([^()\r\n]+)\)|\[([^\]\r\n[]+)\]/dg;

const TRAILING_PUNCT = new Set(['.', ',', ';', ':', ')', ']', "'", '"']);

/**
 * Extracts every path-shaped candidate from one logical terminal line. Pure and
 * exported for unit tests. Offsets are into `text` so a caller can translate
 * them back to per-row buffer coordinates.
 */
export function findPathCandidates(text: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const match of text.matchAll(ENCLOSED_PATH_RE)) {
    const group = match.slice(1).findIndex((value) => value !== undefined) + 1;
    const value = match[group]!;
    if (!value.includes(' ')) continue;
    const parsed = /^(@?)(.+?)(?::(\d{1,6})(?::(\d{1,6}))?)?$/.exec(value);
    if (!parsed) continue;
    const path = parsed[2]!;
    if (!path.includes('/') && !/\.[A-Za-z]\w{0,11}$/.test(path)) continue;
    const start = match.indices![group]![0] + parsed[1]!.length;
    out.push({
      path,
      line: parsed[3] === undefined ? undefined : Number(parsed[3]),
      column: parsed[4] === undefined ? undefined : Number(parsed[4]),
      start,
      end: match.indices![group]![1],
    });
  }
  for (const pattern of [SPACED_DIRECTORY_RE, PATH_RE]) {
    const re = new RegExp(pattern.source, pattern.flags);
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
  }
  const seen = new Set<string>();
  return out
    .filter((candidate) => {
      const key = `${candidate.start}:${candidate.end}:${candidate.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
}
