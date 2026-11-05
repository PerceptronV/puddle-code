import type { IBuffer } from '@xterm/xterm';
import { findPathCandidates } from './file-link-paths';
import { findBufferLinkCandidates, type MappedRow } from './link-buffer';

/**
 * TUIs wrap within a content area, leaving a gutter and repeating indentation.
 * Also allow a deliberate break on either side of a directory separator.
 * Resolution validates every joined path; individual logical lines remain fallbacks.
 */
function hardContinuation(previous: MappedRow, next: MappedRow, cols: number): boolean {
  const left = previous.text.trimEnd();
  const right = next.text.trimStart();
  if (!/[\w.+@~/:-]$/.test(left) || !/^[\w.+@~/:-]/.test(right)) return false;
  // Explicit relative/home prefixes start new paths. A leading slash may be a
  // continuation; keep the standalone absolute path as a resolve fallback.
  if (/^(?:~\/|\.{1,2}\/)/.test(right)) return false;
  const end = previous.cells[left.length - 1];
  return left.endsWith('/') || right.startsWith('/') || (end !== undefined && end.col >= cols - 9);
}

/** File paths retain resolve-validated alternatives for ambiguous TUI wraps. */
export function findBufferPathCandidates(buffer: IBuffer, row0: number, cols: number) {
  return findBufferLinkCandidates(buffer, row0, cols, findPathCandidates, hardContinuation);
}
