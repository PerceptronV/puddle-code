import type { FindOptions } from './find-types';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export interface FindMatch {
  start: number;
  end: number;
}

export interface FindMatches {
  matches: FindMatch[];
  invalid: boolean;
  limited: boolean;
}

/** Compile the same case / whole-word / regex choices exposed by the widget. */
export function findMatcher(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null;
  try {
    let pattern = options.regex ? query : query.replace(REGEX_SPECIALS, '\\$&');
    if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
    return new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

export function isValidFindPattern(query: string, options: FindOptions): boolean {
  return query.length === 0 || findMatcher(query, options) !== null;
}

/** Pure match offsets, shared by rendered-DOM search and its unit tests. */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions,
  limit = 1_000,
): FindMatches {
  const matcher = findMatcher(query, options);
  if (query.length > 0 && matcher === null) {
    return { matches: [], invalid: true, limited: false };
  }
  if (!matcher) return { matches: [], invalid: false, limited: false };

  const matches: FindMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (match[0].length === 0) {
      // A zero-width expression cannot produce a useful highlight. Advance so
      // expressions such as `^` or an empty alternative cannot loop forever.
      matcher.lastIndex++;
      continue;
    }
    if (matches.length === limit) {
      return { matches, invalid: false, limited: true };
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, invalid: false, limited: false };
}
