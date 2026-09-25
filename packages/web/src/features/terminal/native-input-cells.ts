import type { Terminal } from '@xterm/xterm';
import { textSegments, type NativeText } from './native-edit';

type Cell = { row: number; column: number; offset: number };

/** Map only text we typed and can still verify around the live cursor. Never guess TUI prompts. */
export function nativeInputCells(terminal: Terminal, value: NativeText): Cell[] | null {
  if (!value.text) return null;
  const buffer = terminal.buffer.active;
  const cursor = {
    row: buffer.baseY + buffer.cursorY,
    column: buffer.cursorX,
    offset: value.cursor,
  };
  const cells: Cell[] = [cursor];
  const walk = (text: string, direction: -1 | 1) => {
    let { row, column, offset } = cursor;
    const segments = textSegments(text);
    if (direction === -1) segments.reverse();
    for (const { segment } of segments) {
      if (direction === -1) {
        column--;
        if (
          column < 0 ||
          (segment.trim() &&
            !buffer
              .getLine(row)
              ?.translateToString(true, 0, column + 1)
              .trim())
        ) {
          row--;
          column = terminal.cols - 1;
          while (column > 0 && !buffer.getLine(row)?.getCell(column)?.getChars().trim()) column--;
        }
        while (column > 0 && buffer.getLine(row)?.getCell(column)?.getWidth() === 0) column--;
      } else if (
        column >= terminal.cols ||
        (segment.trim() && !buffer.getLine(row)?.translateToString(true, column).trim())
      ) {
        row++;
        column = 0;
        while (
          column < terminal.cols - 1 &&
          !buffer.getLine(row)?.getCell(column)?.getChars().trim()
        )
          column++;
      }
      if (row < buffer.viewportY || row >= buffer.viewportY + terminal.rows) return false;
      const cell = buffer.getLine(row)?.getCell(column);
      if ((cell?.getChars() || ' ') !== segment) return false;
      offset += direction * segment.length;
      if (direction === 1) column += cell!.getWidth();
      cells.push({ row, column, offset });
    }
    return true;
  };
  if (!walk(value.text.slice(0, value.cursor), -1) || !walk(value.text.slice(value.cursor), 1))
    return null;
  return cells;
}

export function tappedInputOffset(
  terminal: Terminal,
  value: NativeText,
  x: number,
  y: number,
): number | null {
  const screen = terminal.element?.querySelector('.xterm-screen');
  const bounds = screen?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height) return null;
  const row =
    terminal.buffer.active.viewportY +
    Math.floor((y - bounds.top) / (bounds.height / terminal.rows));
  const column = Math.round((x - bounds.left) / (bounds.width / terminal.cols));
  const cells = nativeInputCells(terminal, value)?.filter((cell) => cell.row === row);
  if (!cells?.length) return null;
  return cells.reduce((nearest, cell) =>
    Math.abs(cell.column - column) < Math.abs(nearest.column - column) ? cell : nearest,
  ).offset;
}
