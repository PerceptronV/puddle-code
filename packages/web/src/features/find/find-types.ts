export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindResult {
  /** Zero-based active match, or -1 when there is no active match. */
  index: number;
  count: number;
  invalid?: boolean;
  /** The match cap was reached; `count` is therefore a lower bound. */
  limited?: boolean;
}

export type FindDirection = 'reset' | 'next' | 'previous';

export const EMPTY_FIND_RESULT: FindResult = { index: -1, count: 0 };

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};
