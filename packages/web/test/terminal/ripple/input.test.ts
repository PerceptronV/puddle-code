import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { readRippleInput } from '../../../src/features/terminal/ripple/input';
import { rippleView } from '../../../src/features/terminal/ripple/view';

const require = createRequire(new URL('../../../../daemon/package.json', import.meta.url));
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const palette = { theme: {} };
const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

describe('Ripple live input projection', () => {
  it('leaves the default Codex input and footer in the native terminal', async () => {
    const terminal = new HeadlessTerminal({
      cols: 40,
      rows: 12,
      allowProposedApi: true,
    }) as Terminal;
    try {
      await write(terminal, '\x1b[?1049h\x1b[HReply\x1b[9;1H› Draft\x1b[12;1HFooter\x1b[9;4H');
      expect(readRippleInput(terminal, rippleView(terminal, 'codex'), palette)).toBeUndefined();
      const input = readRippleInput(terminal, rippleView(terminal, 'codex', 0), palette)!;
      expect(input.cursor).toMatchObject({ row: 8, col: 3 });
      expect(
        input.rows
          .find((row) => row.row === 8)
          ?.cells.map((cell) => cell.text)
          .join('')
          .trim(),
      ).toBe('› Draft');
      expect(input.rows.at(-1)?.text).toBe('Footer');
      expect(
        readRippleInput(terminal, rippleView(terminal, 'codex', 'cli'), palette),
      ).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  it('preserves wide/combining cells, literal markup and concealed input', async () => {
    const terminal = new HeadlessTerminal({
      cols: 40,
      rows: 12,
      allowProposedApi: true,
    }) as Terminal;
    try {
      await write(
        terminal,
        '\x1b[?1049h\x1b[9;1H› 界é **draft** \x1b[8msecret\x1b[0m\x1b[10;1H  second line\x1b[12;1HFooter\x1b[9;5H',
      );
      const input = readRippleInput(terminal, rippleView(terminal, 'codex', 0), palette)!;
      const row = input.rows.find((row) => row.row === 8)!;
      expect(row.cells.find((cell) => cell.col === 2)).toMatchObject({ text: '界', width: 2 });
      expect(row.cells.some((cell) => cell.col === 3)).toBe(false);
      expect(row.cells.find((cell) => cell.col === 4)?.text).toBe('é');
      const visible = row.cells.map((cell) => cell.text).join('');
      expect(visible).toContain('**draft**');
      expect(visible).not.toContain('secret');
      expect(input.rows.find((row) => row.row === 9)?.text).toBe('  second line');
      await write(terminal, '\x1b[10;6H\x1b[?25l');
      expect(readRippleInput(terminal, rippleView(terminal, 'codex', 0), palette)?.cursor).toEqual({
        row: 9,
        col: 5,
        visible: false,
      });
    } finally {
      terminal.dispose();
    }
  });

  it('does not project a cursor outside the visible covered rows', async () => {
    const terminal = new HeadlessTerminal({
      cols: 40,
      rows: 12,
      allowProposedApi: true,
    }) as Terminal;
    try {
      await write(terminal, '\x1b[9;1H› Draft');
      const view = rippleView(terminal, 'codex', 0);
      expect(readRippleInput(terminal, { ...view, controlsFirst: null }, palette)).toBeUndefined();
      expect(readRippleInput(terminal, { ...view, first: 10 }, palette)).toBeUndefined();
      expect(readRippleInput(terminal, { ...view, coveredLast: 8 }, palette)).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });
});
