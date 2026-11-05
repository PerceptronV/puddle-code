import { Terminal } from '@xterm/xterm';
import { preserveXtermSynchronisedDirtyRows } from '../../src/features/terminal/xterm-synchronised-output';

const terminal = new Terminal({ cols: 80, rows: 24, cursorBlink: false, allowProposedApi: true });
if (location.search === '?patched') {
  preserveXtermSynchronisedDirtyRows(terminal);
  preserveXtermSynchronisedDirtyRows(terminal);
}
terminal.open(document.getElementById('terminal')!);
let renderedRows = 0;
terminal.onRender(({ start, end }) => (renderedRows += end - start + 1));
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const write = async (data: string) => {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  await settle();
};
const snapshot = () => {
  const buffer = terminal.buffer.active;
  return {
    rows: terminal.element!.querySelector('.xterm-rows')!.innerHTML,
    lines: Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)!.translateToString(),
    ),
    cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY, buffer.viewportY],
    selection: terminal.getSelection(),
    modes: terminal.modes,
  };
};
Object.assign(window, {
  terminal,
  write,
  snapshot,
  settle,
  renderedRows: () => renderedRows,
});
