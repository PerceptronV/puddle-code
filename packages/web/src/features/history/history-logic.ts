/**
 * Pure presentation logic for the history view (SPEC §8, Task 3.6d): relative
 * and absolute time formatting, the commit-body-vs-subject split, the
 * root-commit status override, and the file-list default-expand rule.
 * Monaco-free and side-effect-free so it is unit-testable under vitest —
 * the Monaco-touching rendering lives behind the lazy boundary
 * (HistoryFileContent.tsx) and is exercised manually.
 */
import type { DiffStatus } from '@puddle/shared';

/** All date/time rendering is fixed to UTC, not the viewer's local zone: a
 * commit's `authored_at` already carries the author's own offset (git's
 * `%aI`), and formatting against the *viewer's* local zone would additionally
 * make this non-deterministic under vitest (CI runners' TZ varies). Pick
 * UTC as one fixed, documented rendering zone rather than either problem. */
const DATE_TZ = 'UTC';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: DATE_TZ,
  });
}

/** Full date + time (commit detail's author line), e.g. "14 Jul 2026, 09:15". */
export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DATE_TZ,
  });
  return `${formatDate(d.getTime())}, ${time}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * "just now" / "5 m ago" / "3 h ago" / "2 d ago", then a plain date once a
 * commit is a week or older. `now` is injectable so this is deterministic
 * under test; a future `iso` (clock skew) clamps to "just now" rather than
 * going negative.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (diffSec < MINUTE) return 'just now';
  if (diffSec < HOUR) return `${Math.floor(diffSec / MINUTE)} m ago`;
  if (diffSec < DAY) return `${Math.floor(diffSec / HOUR)} h ago`;
  if (diffSec < WEEK) return `${Math.floor(diffSec / DAY)} d ago`;
  return formatDate(then);
}

/**
 * `%B` (the commit's full message, used verbatim as `body`) always leads with
 * the subject line followed by a blank-line separator before any further
 * body text (git's own convention — the same as `%s` vs. `%b`). Strip that
 * leading "subject\n\n" so the detail view only renders body text that adds
 * something beyond the subject already shown in the header; a subject-only
 * commit (no further paragraphs) yields ''.
 */
export function bodyBeyondSubject(body: string): string {
  const firstBreak = body.indexOf('\n');
  const rest = firstBreak === -1 ? '' : body.slice(firstBreak + 1);
  return rest.replace(/^\n+/, '').replace(/\s+$/, '');
}

/**
 * The root (first) commit has no parent, so every one of its files is
 * conceptually "added" — there is no `sha^` to diff against. `diff-tree
 * --root` already reports every file as `added` for it (inspect.ts), but the
 * client re-asserts this itself rather than trusting that implicitly: it is
 * the one place that decides whether `sha^` is ever fetched, and it must not
 * depend on the 404 that fetching a nonexistent parent would produce.
 */
export function effectiveStatus(status: DiffStatus, isRootCommit: boolean): DiffStatus {
  return isRootCommit ? 'added' : status;
}

/**
 * Per-commit file sections start collapsed, EXCEPT when the commit touches
 * few enough files (≤3) that showing every diff at once is still a quick
 * scan rather than a wall of Monaco instances — mirrors the diff view's
 * "first N expanded" rule in spirit, but keyed on the commit's total file
 * count rather than a per-row index (a history commit is usually small; the
 * common case is showing everything).
 */
const DEFAULT_EXPAND_FILE_LIMIT = 3;

export function defaultFileExpanded(fileCount: number): boolean {
  return fileCount <= DEFAULT_EXPAND_FILE_LIMIT;
}
