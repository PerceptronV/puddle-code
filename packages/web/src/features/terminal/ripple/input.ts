import type { Terminal } from '@xterm/xterm';
import { rippleCellStyle } from './cell-style';
import { rippleCursorVisible, type RipplePalette } from './xterm-style';
import type { rippleView } from './view';

export interface RippleInputSnapshot {
  first: number;
  cols: number;
  viewport: number;
  bufferType: string;
  cursor: { row: number; col: number; visible: boolean };
  cellHeight: number;
  fontSize: number;
  fontFamily: string;
  rows: {
    row: number;
    text: string;
    cells: { col: number; width: number; text: string; css: string }[];
  }[];
}

/** Project live controls only when the split actually covers the native caret.
 * Drafts stay literal; Markdown and rich-output parsers never rewrite editing cells. */
export function readRippleInput(
  terminal: Terminal,
  view: ReturnType<typeof rippleView>,
  palette: RipplePalette,
): RippleInputSnapshot | undefined {
  const buffer = terminal.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  if (row < view.first || row >= view.coveredLast) return;
  // A cursor parked in history/output is not an editable composer.
  if (view.controlsFirst === null) return;
  const first = view.controlsFirst;
  if (row < first) return;
  const rows: RippleInputSnapshot['rows'] = [];
  for (let index = first; index < view.coveredLast; index++) {
    const line = buffer.getLine(index);
    if (!line) break;
    const cells: RippleInputSnapshot['rows'][number]['cells'] = [];
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line.getCell(col);
      const width = cell?.getWidth() ?? 1;
      if (!width) continue;
      cells.push({
        col,
        width,
        text: cell?.isInvisible() ? ' ' : cell?.getChars() || ' ',
        css: rippleCellStyle(cell, palette.theme, palette),
      });
    }
    rows.push({ row: index, text: line.translateToString(true), cells });
  }
  return {
    first,
    rows,
    cols: terminal.cols,
    viewport: buffer.viewportY,
    bufferType: buffer.type,
    cursor: {
      row,
      col: Math.min(terminal.cols - 1, buffer.cursorX),
      visible: rippleCursorVisible(terminal),
    },
    cellHeight: view.cellHeight,
    fontSize: terminal.options.fontSize ?? 14,
    fontFamily: terminal.options.fontFamily ?? 'monospace',
  };
}
