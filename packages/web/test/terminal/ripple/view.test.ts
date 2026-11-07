import { describe, expect, it } from 'vitest';
import type { IBufferCell, Terminal } from '@xterm/xterm';
import { bufferWithLines } from '../../helpers/terminal-buffer';
import { rippleView } from '../../../src/features/terminal/ripple/view';
import {
  rippleCellStyle,
  markRippleStyles,
} from '../../../src/features/terminal/ripple/cell-style';
import { readRippleBuffer } from '../../../src/features/terminal/ripple/buffer';
import { rippleBoundaries } from '../../../src/features/terminal/ripple/preferences';

function screen(rows = 30) {
  const buffer = bufferWithLines(
    Array.from({ length: rows }, (_, i) => ({
      text:
        i === rows - 4
          ? '› Ask Codex to do anything'
          : i === rows - 1
            ? 'Status'
            : i < rows - 5
              ? `Row ${i}`
              : '',
    })),
    80,
  );
  Object.assign(buffer, { viewportY: 0, baseY: 0, cursorY: rows - 4 });
  const getLine = buffer.getLine.bind(buffer);
  buffer.getLine = (row) => {
    const line = getLine(row);
    if (!line) return line;
    const getCell = line.getCell.bind(line);
    return {
      ...line,
      getCell: (column, target) => {
        const cell = getCell(column, target);
        if (cell) {
          cell.getBgColorMode = () => 0;
          cell.getBgColor = () => -1;
        }
        return cell;
      },
    };
  };
  return { rows, cols: 80, buffer: { active: buffer } } as Terminal;
}
describe('Ripple overlay boundary', () => {
  it('leaves the Codex composer and footer native and clips them out of the reader', () => {
    const terminal = screen();
    const view = rippleView(terminal, 'codex');
    expect(view.nativeRows).toBe(5);
    expect(readRippleBuffer(terminal.buffer.active, 80, view).text).not.toContain('Ask Codex');
  });
  it('keeps Working, tips and a blank row native while preserving a manual boundary', () => {
    const terminal = screen();
    const old = terminal.buffer.active.getLine.bind(terminal.buffer.active);
    terminal.buffer.active.getLine = (row) => {
      if (row === 20)
        return bufferWithLines([{ text: '• Working (12s • esc to interrupt)' }], 80).getLine(0);
      if (row === 19) return bufferWithLines([{ text: '' }], 80).getLine(0);
      return old(row);
    };
    expect(rippleView(terminal, 'codex').nativeRows).toBe(11);
    expect(rippleView(terminal, 'codex', 5).nativeRows).toBe(5);
    const view = rippleView(terminal, 'codex');
    expect(readRippleBuffer(terminal.buffer.active, 80, view).text).not.toContain('Working');
  });
  it('includes the fractional fit remainder so the overlay cannot clip a native row', () => {
    const terminal = screen();
    Object.assign(terminal, {
      element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ height: 480, bottom: 600 }) }),
        closest: () => ({ getBoundingClientRect: () => ({ bottom: 607 }) }),
      },
    });
    expect(rippleView(terminal, 'codex').bottom).toBe(5 * 16 + 7);
    expect(rippleView(terminal, 'codex', 8).bottom).toBe(8 * 16 + 7);
  });
  it('anchors manual placement by native rows across taller and shorter terminals', () => {
    expect(rippleView(screen(30), 'codex', 8).nativeRows).toBe(8);
    expect(rippleView(screen(40), 'codex', 8).nativeRows).toBe(8);
    expect(rippleView(screen(10), 'codex', 8).nativeRows).toBe(7);
    expect(rippleView(screen(40), 'codex', 8).nativeRows).toBe(8);
  });
  it('reads the scrolled viewport rather than the end of normal scrollback', () => {
    const terminal = screen(50);
    const snapshot = readRippleBuffer(terminal.buffer.active, 80, { first: 5, last: 10 });
    expect(snapshot.text).toBe('Row 5\nRow 6\nRow 7\nRow 8\nRow 9');
  });
  it('finds the composer in a short normal-buffer conversation', () => {
    const terminal = screen(60);
    const buffer = bufferWithLines(
      Array.from({ length: 60 }, (_, row) => ({
        text:
          row === 12
            ? '> Type your message'
            : row === 11
              ? '▄▄▄▄▄▄▄▄▄▄▄▄'
              : row === 10
                ? 'Reply'
                : '',
      })),
      80,
    );
    Object.assign(buffer, { viewportY: 0, baseY: 0, cursorY: 15, type: 'normal' });
    Object.assign(terminal, { buffer: { active: buffer } });
    expect(rippleView(terminal, 'gemini-cli').last).toBe(11);
    expect(rippleView(terminal, 'gemini-cli').nativeRows).toBe(5);
    expect(rippleView(terminal, 'gemini-cli').nativeOffset).toBe(44 * 16);
    expect(rippleView(terminal, 'gemini-cli', 8).nativeRows).toBe(8);
  });
  it('rejects invalid persisted boundaries and bounds the session map', () => {
    expect(rippleBoundaries('{"a":5,"b":0,"c":1.2,"d":"3"}')).toEqual({ a: 5 });
    expect(rippleBoundaries('invalid')).toEqual({});
    expect(
      Object.keys(
        rippleBoundaries(
          JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [i, 5]))),
        ),
      ).length,
    ).toBe(256);
  });
  it('omits a recognised Gemini scrollbar only in its alternate-screen layout', () => {
    const terminal = screen();
    const buffer = bufferWithLines(
      Array.from({ length: 30 }, (_, row) => ({
        text:
          row === 26
            ? '> Draft'
            : row === 25
              ? '▄▄▄▄▄▄▄▄'
              : row < 20
                ? 'Reply'.padEnd(79) + '█'
                : '',
      })),
      80,
    );
    Object.assign(buffer, { viewportY: 0, baseY: 0, cursorY: 26, type: 'alternate' });
    Object.assign(terminal, { buffer: { active: buffer } });
    const view = rippleView(terminal, 'gemini-cli');
    expect(view.lastCol).toBe(79);
    expect(readRippleBuffer(buffer, 80, view).text).not.toContain('█');
    expect(rippleView(terminal, 'codex').lastCol).toBe(80);
    Object.assign(buffer, { type: 'normal' });
    expect(rippleView(terminal, 'gemini-cli').lastCol).toBe(80);
  });
});
describe('Ripple terminal styles', () => {
  it('retains palette/RGB foreground, background and emphasis without exposing invisible cells', () => {
    const cell = {
      isBold: () => 1,
      isItalic: () => 1,
      isUnderline: () => 1,
      isFgPalette: () => true,
      getFgColor: () => 1,
      isBgRGB: () => true,
      isBgPalette: () => false,
      getBgColor: () => 0x123456,
    } as unknown as IBufferCell;
    const css = rippleCellStyle(cell, { red: '#ff0000' });
    expect(css).toContain('font-weight:700');
    expect(css).toContain('font-style:italic');
    expect(css).toContain('text-decoration:underline');
    expect(css).toContain('color:#ff0000');
    expect(css).toContain('background-color:#123456');
    expect(rippleCellStyle({ ...cell, isInvisible: () => 1 }, {})).toBe('');
  });
  it('keeps terminal text that resembles a private style marker literal', () => {
    const text = '\uE000ripple0\uE001 <img src=x>';
    const marked = markRippleStyles(text, [{ start: 0, end: text.length, css: 'font-weight:700' }]);
    expect(marked.restore(marked.text)).toBe(`<span style="font-weight:700">${text}</span>`);
  });
});
