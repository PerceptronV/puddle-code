import type { IBuffer } from '@xterm/xterm';
import { findBufferUrlCandidates, findUrlCandidates } from '../links/url-links';
import { findBufferPathCandidates } from '../links/file-link-buffer';
import { findPathCandidates, type PathCandidate } from '../links/file-link-paths';
import type { CellPosition } from '../links/link-buffer';
import type { RippleStyle } from './cell-style';

type Action = { kind: 'url'; uri: string } | { kind: 'file'; candidates: PathCandidate[] };
export type RippleAction = Action & { start: number; end: number };

/** Reuse the native terminal's bounded wrap-aware candidate detection. */
export function rippleActions(
  buffer: IBuffer,
  cols: number,
  first: number,
  last: number,
  offsetAt: (cell: CellPosition, end: boolean) => number | undefined,
): RippleAction[] {
  const actions: RippleAction[] = [];
  const seen = new Set<string>();
  const counts = { url: 0, file: 0 };
  const add = (start: CellPosition, end: CellPosition, action: Action) => {
    const from = offsetAt(start, false);
    const to = offsetAt(end, true);
    if (from === undefined || to === undefined || to <= from) return;
    const key = `${action.kind}:${from}:${to}`;
    if (seen.has(key)) return;
    if (counts[action.kind] >= (action.kind === 'file' ? 128 : 64)) return;
    seen.add(key);
    counts[action.kind]++;
    actions.push({ ...action, start: from, end: to });
  };
  for (let row = first; row < last; row++) {
    const text = buffer.getLine(row)?.translateToString(true) ?? '';
    if (counts.url < 64 && (findUrlCandidates(text).length || /https?:\/\//i.test(text)))
      for (const link of findBufferUrlCandidates(buffer, row, cols))
        add(link.start, link.end, { kind: 'url', uri: link.candidate.uri });
    if (counts.file < 128 && findPathCandidates(text).length)
      for (const link of findBufferPathCandidates(buffer, row, cols))
        add(link.start, link.end, { kind: 'file', candidates: [link.candidate] });
  }

  // Prefer full URLs over path-shaped substrings and full wrapped targets over
  // their shorter fallback. Unknown/missing paths are still resolved on demand.
  const chosen: RippleAction[] = [];
  for (const action of actions.sort(
    (a, b) =>
      Number(b.kind === 'url') - Number(a.kind === 'url') || b.end - b.start - (a.end - a.start),
  )) {
    if (action.kind === 'file') continue;
    if (!chosen.some((other) => action.start < other.end && action.end > other.start))
      chosen.push(action);
  }
  // Keep native path detection's shorter resolve-validated alternatives. Split
  // at their boundaries so a click beyond a short candidate cannot open it.
  const files = actions.filter((action) => action.kind === 'file');
  const edges = [...new Set(files.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b);
  for (let index = 0; index < edges.length - 1; index++) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    if (chosen.some((action) => start < action.end && end > action.start)) continue;
    const candidates = files
      .filter((action) => action.start <= start && action.end >= end)
      .flatMap((action) => action.candidates);
    if (candidates.length) chosen.push({ kind: 'file', start, end, candidates });
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** Split only at style/link boundaries; never insert overlapping marker ranges. */
export function rippleActionStyles(styles: RippleStyle[], actions: RippleAction[]): RippleStyle[] {
  if (!actions.length) return styles;
  const boundaries = [
    ...new Set([...styles, ...actions].flatMap(({ start, end }) => [start, end])),
  ].sort((a, b) => a - b);
  const result: RippleStyle[] = [];
  let styleIndex = 0;
  let actionIndex = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    while (styles[styleIndex] && styles[styleIndex]!.end <= start) styleIndex++;
    while (actions[actionIndex] && actions[actionIndex]!.end <= start) actionIndex++;
    const style =
      styles[styleIndex] && styles[styleIndex]!.start <= start ? styles[styleIndex] : undefined;
    const action = actions[actionIndex] && actions[actionIndex]!.start <= start ? actionIndex : -1;
    if (!style && action < 0) continue;
    result.push({
      ...style,
      start,
      end,
      css: style?.css ?? '',
      ...(action >= 0 && !style?.href
        ? ({
            action,
            actionKind: actions[action]!.kind,
            actionRole: 'link',
          } as const)
        : {}),
    });
  }
  return result;
}
