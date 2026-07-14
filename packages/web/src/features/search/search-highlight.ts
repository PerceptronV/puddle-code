/**
 * Pure match-highlighting for the Search navigator (SPEC §8): builds the same
 * matcher the daemon's `git grep` used (fixed string or regex, case + whole
 * word) and splits a result line into hit / non-hit segments the row renders
 * as highlighted spans. An invalid regex yields a null matcher (the row renders
 * plain, never throwing). DOM-free — unit-testable.
 */

export interface HighlightOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface Segment {
  text: string;
  hit: boolean;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** The RegExp mirroring the search flags, or null when the pattern is invalid. */
export function buildMatcher(opts: HighlightOptions): RegExp | null {
  if (opts.query.length === 0) return null;
  try {
    let pattern = opts.regex ? opts.query : opts.query.replace(REGEX_SPECIALS, '\\$&');
    if (opts.wholeWord) pattern = `\\b(?:${pattern})\\b`;
    return new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Split `text` into alternating non-hit / hit segments using `matcher`. */
export function splitHighlight(text: string, matcher: RegExp | null): Segment[] {
  if (!matcher) return [{ text, hit: false }];
  const segments: Segment[] = [];
  let last = 0;
  matcher.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(text)) !== null) {
    if (m[0].length === 0) {
      // Zero-width match (e.g. an empty alternation): step past it so exec
      // can't loop forever.
      matcher.lastIndex++;
      continue;
    }
    if (m.index > last) segments.push({ text: text.slice(last, m.index), hit: false });
    segments.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments.length > 0 ? segments : [{ text, hit: false }];
}

/** Longest preview line we render before trimming — keeps a minified file sane. */
const MAX_PREVIEW = 240;

/** Trim leading indentation and cap the length for a match-preview line. */
export function trimPreview(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  return trimmed.length > MAX_PREVIEW ? `${trimmed.slice(0, MAX_PREVIEW)}…` : trimmed;
}
