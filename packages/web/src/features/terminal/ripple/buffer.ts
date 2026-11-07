import type { IBuffer, ITheme } from '@xterm/xterm';
import { rippleCellStyle, type RippleStyle } from './cell-style';
import { readRow } from '../links/link-buffer';
import { terminalRichBlocks } from '../rich-output/rich-output-buffer';
import type { RipplePalette } from './xterm-style';
import { rippleActions, rippleActionStyles, type RippleAction } from './interactions';
import type { RippleSourceMap } from './source-map';

export const RIPPLE_MAX_ROWS = 600;
// Match the shared rich-output detector's scan budget.
export const RIPPLE_MAX_CHARACTERS = 32_768;

export type RipplePart =
  | { kind: 'text'; source: string; styles?: RippleStyle[]; offset?: number }
  | { kind: 'mermaid' | 'math'; source: string; display: boolean };

export interface RippleSnapshot {
  text: string;
  truncated: boolean;
  alternate: boolean;
  parts: RipplePart[];
  foreground?: string;
  background?: string;
  actions?: RippleAction[];
  sourceMap?: RippleSourceMap;
}

/** A bounded projection of the current screen, never a second terminal parser or log. */
export function readRippleBuffer(
  buffer: IBuffer,
  cols: number,
  view?: { first: number; last: number; firstCol?: number; lastCol?: number },
  theme: ITheme = {},
  palette?: RipplePalette,
): RippleSnapshot {
  const last = Math.min(buffer.length, view?.last ?? buffer.length);
  // Reserve the newest rows even when a single row is extremely wide.
  const count = Math.min(RIPPLE_MAX_ROWS, Math.floor(RIPPLE_MAX_CHARACTERS / (cols + 1)));
  let first = Math.max(0, view?.first ?? 0, last - count);
  // A partial logical line could begin midway through code or a URL. Omit it.
  while (first < last && buffer.getLine(first)?.isWrapped) first++;
  const lines: string[] = [];
  const rows = new Map<
    number,
    {
      offset: number;
      cells: NonNullable<ReturnType<typeof readRow>>['cells'];
      length: number;
      concealed: boolean;
    }
  >();
  let size = 0;
  let offset = 0;
  let styles: RippleStyle[] = [];
  for (let row = first; row < last; row++) {
    const mapped = readRow(buffer, row, cols, view);
    if (!mapped) break;
    // Concealed ANSI cells must remain concealed in the proportional view too.
    let concealed = false;
    const visible = mapped.text
      .split('')
      .map((char, index) => {
        const position = mapped.cells[index]!;
        if (buffer.getLine(row)?.getCell(position.col)?.isInvisible?.()) {
          concealed = true;
          return ' ';
        }
        return char;
      })
      .join('');
    let end = buffer.getLine(row + 1)?.isWrapped ? visible.length : visible.trimEnd().length;
    // Backgrounds and decorations on spaces carry meaning (diffs, swatches,
    // underlined fields). Discard only unpainted terminal padding.
    for (let index = visible.length - 1; index >= end; index--) {
      const cell = buffer.getLine(row)?.getCell(mapped.cells[index]!.col);
      if (
        cell &&
        !cell.isInvisible?.() &&
        rippleCellStyle(cell, theme, palette).includes('white-space:')
      ) {
        end = index + 1;
        break;
      }
    }
    const text = visible.slice(0, end);
    if (size + text.length + 1 > RIPPLE_MAX_CHARACTERS) break;
    size += text.length + 1;
    if (!mapped.isWrapped && lines.length) offset++;
    for (let index = 0; index < text.length; index++) {
      const cell = buffer.getLine(row)?.getCell(mapped.cells[index]!.col);
      const css = rippleCellStyle(cell, theme, palette);
      const href = cell && palette?.link?.(cell);
      if (!css && !href) continue;
      const previous = styles.at(-1);
      const start = offset + index;
      if (previous && previous.end === start && previous.css === css && previous.href === href)
        previous.end++;
      else styles.push({ start, end: start + 1, css, ...(href && { href }) });
    }
    rows.set(row, { offset, cells: mapped.cells, length: text.length, concealed });
    offset += text.length;
    if (mapped.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const joined = lines.join('\n');
  const text = joined.slice(0, Math.max(joined.trimEnd().length, styles.at(-1)?.end ?? 0));
  const actions = rippleActions(buffer, cols, first, last, (cell, end) => {
    const row = rows.get(cell.row);
    if (!row || row.concealed) return;
    const index = end
      ? row.cells.findLastIndex((item) => item.col <= cell.col)
      : row.cells.findIndex((item) => item.col === cell.col);
    if (index < 0 || index >= row.length) return;
    const column = row.cells[index]!.col;
    const width = buffer.getLine(cell.row)?.getCell(column)?.getWidth() ?? 1;
    if (cell.col >= column + Math.max(1, width)) return;
    return row.offset + index + (end ? 1 : 0);
  });
  styles = rippleActionStyles(styles, actions);
  const parts: RipplePart[] = [];
  const addText = (from: number, to: number) => {
    const ranges = styles
      .filter((range) => range.end > from && range.start < to)
      .map((range) => ({
        ...range,
        start: Math.max(from, range.start) - from,
        end: Math.min(to, range.end) - from,
      }));
    parts.push({
      kind: 'text',
      source: text.slice(from, to),
      ...(view && { offset: from }),
      ...(ranges.length ? { styles: ranges } : {}),
    });
  };
  let at = 0;
  for (const block of terminalRichBlocks(buffer, cols, first, last - first, view)) {
    const start = rows.get(block.start.row);
    const end = rows.get(block.end.row);
    if (!start || !end) continue;
    // Never let a typesetter reveal concealed source cells.
    if (
      [...rows.entries()].some(
        ([row, value]) => row >= block.start.row && row <= block.end.row && value.concealed,
      )
    )
      continue;
    const startIndex = start.cells.findIndex((cell) => cell.col >= block.start.col);
    const endIndex = end.cells.findLastIndex((cell) => cell.col <= block.end.col) + 1;
    if (startIndex < 0 || endIndex === 0) continue;
    const from = start.offset + Math.min(start.length, startIndex);
    const to = Math.min(text.length, end.offset + Math.min(end.length, endIndex));
    if (from < at || to <= from) continue;
    if (from > at) addText(at, from);
    parts.push({ kind: block.kind, source: block.source, display: block.display });
    at = to;
  }
  if (at < text.length) addText(at, text.length);
  return {
    text,
    truncated: first > 0,
    alternate: buffer.type === 'alternate',
    parts,
    ...(actions.length ? { actions } : {}),
    ...(view && {
      sourceMap: {
        cols,
        viewport: buffer.viewportY,
        bufferType: buffer.type,
        rows: [...rows.entries()]
          .filter(([, row]) => !row.concealed)
          .map(([number, row]) => ({
            row: number,
            start: row.offset,
            columns: row.cells.slice(0, row.length).map((cell) => cell.col),
            text: buffer.getLine(number)?.translateToString(true) ?? '',
          })),
      },
    }),
    ...(palette && { foreground: theme.foreground, background: theme.background }),
  };
}
