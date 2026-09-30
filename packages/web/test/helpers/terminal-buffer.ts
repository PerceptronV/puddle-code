import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm';

export function bufferWithLines(
  rows: Array<{ text: string; isWrapped?: boolean; storedLength?: number }>,
  cols: number,
): IBuffer {
  const lines = rows.map(({ text, isWrapped = false, storedLength = cols }): IBufferLine => {
    const padded = text.padEnd(storedLength, ' ');
    return {
      isWrapped,
      length: storedLength,
      getCell(x, target) {
        if (x < 0 || x >= storedLength) return undefined;
        const value = padded[x] ?? ' ';
        const cell = (target ?? {}) as IBufferCell & { value?: string };
        cell.value = value;
        cell.getChars = function () {
          return this.value === ' ' ? '' : (this.value ?? '');
        };
        cell.getWidth = () => 1;
        return cell;
      },
      translateToString(trimRight = false, start = 0, end = storedLength) {
        const value = padded.slice(start, end);
        return trimRight ? value.trimEnd() : value;
      },
    } as IBufferLine;
  });
  return {
    getLine: (y: number) => lines[y],
    getNullCell: () => ({}) as IBufferCell,
  } as IBuffer;
}
