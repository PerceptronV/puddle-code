import { Terminal } from '@xterm/xterm';
import {
  captureParkedTerminal,
  restoreParkedTerminal,
} from '../../src/features/terminal/parked/snapshot';

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));
function create(cols = 80, rows = 24, scrollback = 20000) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  terminal.open(container);
  return {
    terminal,
    dispose() {
      terminal.dispose();
      container.remove();
    },
  };
}
function signature(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type,
    lines: Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)!;
      return [
        line.isWrapped,
        Array.from({ length: terminal.cols }, (_, col) => {
          const cell = line.getCell(col)!;
          return [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColorMode(),
            cell.getFgColor(),
            cell.getBgColorMode(),
            cell.getBgColor(),
            cell.isBold(),
            cell.isItalic(),
            cell.isUnderline(),
            cell.isInverse(),
          ];
        }),
      ];
    }),
    cursor: [buffer.cursorX, buffer.cursorY],
    viewportY: buffer.viewportY,
    modes: terminal.modes,
    cursorStyle: terminal.options.cursorStyle,
    cursorHidden: (terminal as unknown as { _core: { coreService: { isCursorHidden: boolean } } })
      ._core.coreService.isCursorHidden,
  };
}
Object.assign(window, {
  async checkSnapshot(content: string, alternate = false) {
    const source = create();
    const restored = create();
    try {
      await write(source.terminal, content);
      if (!alternate) source.terminal.scrollToLine(5);
      const before = signature(source.terminal);
      const snapshot = captureParkedTerminal(source.terminal);
      if (!snapshot) throw new Error('Unexpected unsupported fixture');
      await restoreParkedTerminal(restored.terminal, snapshot);
      const after = signature(restored.terminal);
      const result: Record<string, unknown> = { before, after };
      if (alternate) {
        await write(source.terminal, '\x1b[?1049l');
        await write(restored.terminal, '\x1b[?1049l');
        result.normalBefore = signature(source.terminal);
        result.normalAfter = signature(restored.terminal);
      }
      return result;
    } finally {
      source.dispose();
      restored.dispose();
    }
  },
  async unsupported() {
    const view = create();
    try {
      await write(view.terminal, 'select me');
      view.terminal.select(0, 0, 6);
      const selection = captureParkedTerminal(view.terminal) === null;
      view.terminal.clearSelection();
      await write(view.terminal, '\x1b]8;;https://example.test/\x07link\x1b]8;;\x07');
      const link = captureParkedTerminal(view.terminal) === null;
      view.terminal.reset();
      await write(view.terminal, '\x1b[?1049hALT\x1b[31mred');
      const alternate = captureParkedTerminal(view.terminal) === null;
      view.terminal.reset();
      await write(view.terminal, '\x1b[?2026h');
      const synchronised = captureParkedTerminal(view.terminal) === null;
      return { selection, link, alternate, synchronised };
    } finally {
      view.dispose();
    }
  },
});
