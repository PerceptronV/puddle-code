import type { IBuffer } from '@xterm/xterm';
import { readRow } from '../links/link-buffer';
import { terminalRichBlocks } from '../rich-output/rich-output-buffer';

export const RIPPLE_MAX_ROWS = 600;
// Match the shared rich-output detector's scan budget.
export const RIPPLE_MAX_CHARACTERS = 32_768;

export type RipplePart =
  { kind: 'text'; source: string } | { kind: 'mermaid' | 'math'; source: string; display: boolean };

export interface RippleSnapshot {
  text: string;
  truncated: boolean;
  alternate: boolean;
  parts: RipplePart[];
}

/** A bounded projection of the current screen, never a second terminal parser or log. */
export function readRippleBuffer(buffer: IBuffer, cols: number): RippleSnapshot {
  if (buffer.type === 'alternate')
    return { text: '', truncated: false, alternate: true, parts: [] };
  const last = buffer.length;
  // Reserve the newest rows even when a single row is extremely wide.
  const count = Math.min(RIPPLE_MAX_ROWS, Math.floor(RIPPLE_MAX_CHARACTERS / (cols + 1)));
  let first = Math.max(0, last - count);
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
  for (let row = first; row < last; row++) {
    const mapped = readRow(buffer, row, cols);
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
    const text = buffer.getLine(row + 1)?.isWrapped ? visible : visible.trimEnd();
    if (size + text.length + 1 > RIPPLE_MAX_CHARACTERS) break;
    size += text.length + 1;
    if (!mapped.isWrapped && lines.length) offset++;
    rows.set(row, { offset, cells: mapped.cells, length: text.length, concealed });
    offset += text.length;
    if (mapped.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const text = lines.join('\n').trimEnd();
  const parts: RipplePart[] = [];
  let at = 0;
  for (const block of terminalRichBlocks(buffer, cols, first, last - first)) {
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
    if (from > at) parts.push({ kind: 'text', source: text.slice(at, from) });
    parts.push({ kind: block.kind, source: block.source, display: block.display });
    at = to;
  }
  if (at < text.length) parts.push({ kind: 'text', source: text.slice(at) });
  return { text, truncated: first > 0, alternate: false, parts };
}
