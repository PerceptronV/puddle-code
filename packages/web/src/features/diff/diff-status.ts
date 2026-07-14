/**
 * Pure presentation logic for the diff view (SPEC §8): mapping a git diff
 * status to its one-letter glyph, human label, and semantic colour utility,
 * plus the header count summary and the default-expand rule. Monaco-free and
 * side-effect-free so it is unit-testable under vitest — the heavy Monaco
 * rendering lives in `FileDiffSection.tsx` behind the lazy boundary.
 */
import type { DiffEntry, DiffStatus } from '@puddle/shared';

export interface DiffStatusStyle {
  /** The single-letter glyph shown at the head of a section (A/M/D/R). */
  letter: string;
  /** Lower-case word used in the header summary ("3 modified · 1 added"). */
  label: string;
  /**
   * A semantic colour utility (never a raw hex) reused from the status palette:
   * added→running (green), deleted→interrupted (red), modified→fg-secondary,
   * renamed→waiting (amber). See SPEC §12 / tokens.css.
   */
  colourClass: string;
}

const STYLES: Record<DiffStatus, DiffStatusStyle> = {
  added: { letter: 'A', label: 'added', colourClass: 'text-running' },
  modified: { letter: 'M', label: 'modified', colourClass: 'text-fg-secondary' },
  deleted: { letter: 'D', label: 'deleted', colourClass: 'text-interrupted' },
  renamed: { letter: 'R', label: 'renamed', colourClass: 'text-waiting' },
};

export function diffStatusStyle(status: DiffStatus): DiffStatusStyle {
  return STYLES[status];
}

/** Fixed presentation order for the header summary — most-common change first. */
const SUMMARY_ORDER: readonly DiffStatus[] = ['modified', 'added', 'deleted', 'renamed'];

/**
 * "3 modified · 1 added" — counts per status in a stable order, omitting any
 * status with no entries. Empty when there are no entries at all.
 */
export function summariseCounts(entries: readonly Pick<DiffEntry, 'status'>[]): string {
  const counts = new Map<DiffStatus, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  return SUMMARY_ORDER.filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${STYLES[status].label}`)
    .join(' · ');
}

/**
 * How many diff sections open expanded on first render. Beyond this the
 * sections start collapsed so a large diff does not mount dozens of Monaco
 * instances at once (each still mounts lazily on scroll — see FileDiffSection).
 * Five keeps the common small-diff case fully visible without a click.
 */
export const DEFAULT_EXPANDED_LIMIT = 5;

export function defaultExpanded(index: number, limit = DEFAULT_EXPANDED_LIMIT): boolean {
  return index < limit;
}
