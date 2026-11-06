import type { Terminal } from '@xterm/xterm';

/** Keep the real composer visible without resizing or moving the underlying PTY. */
export function rippleView(
  terminal: Terminal,
  agentType?: string,
  nativeRows: number | null = null,
) {
  const buffer = terminal.buffer.active;
  const first = buffer.viewportY;
  let composer = Math.max(0, terminal.rows - 5);
  if (nativeRows !== null) composer = Math.max(3, terminal.rows - nativeRows);
  else if (agentType === 'codex') {
    // Codex pins its composer to the cursor, including multiline input. Search
    // backwards only in the lower screen so an earlier user message cannot win.
    const cursor = Math.min(first + terminal.rows - 1, buffer.baseY + buffer.cursorY);
    for (let row = cursor; row >= first + Math.floor(terminal.rows / 2); row--) {
      const line = buffer.getLine(row);
      if (!/^\s*[›❯>]\s/.test(line?.translateToString(true) ?? '')) continue;
      composer = row - first;
      // Include the composer's top padding when it carries the same backing.
      const above = buffer.getLine(row - 1);
      if (
        above &&
        !above.translateToString(true).trim() &&
        above.getCell(0)?.getBgColorMode() === line?.getCell(0)?.getBgColorMode() &&
        above.getCell(0)?.getBgColor() === line?.getCell(0)?.getBgColor()
      )
        composer--;
      break;
    }
  }
  composer = Math.max(0, Math.min(terminal.rows - 1, composer));
  let last = first + composer;
  // Codex's scroll hint belongs to its controls, not the answer being read.
  if (agentType === 'codex') {
    while (last > first) {
      const text =
        buffer
          .getLine(last - 1)
          ?.translateToString(true)
          .trim() ?? '';
      if (text && !/^(?:New activity\s*·\s*)?↓\s*Back to bottom\b/.test(text)) break;
      last--;
    }
  }
  const screen = terminal.element?.querySelector('.xterm-screen');
  const cellHeight = (screen?.getBoundingClientRect().height || terminal.rows * 16) / terminal.rows;
  return {
    first,
    last,
    nativeRows: terminal.rows - composer,
    cellHeight,
    bottom: Math.max(0, terminal.rows - composer) * cellHeight,
  };
}

/** xterm owns wheel acceleration and the application's negotiated mouse protocol. */
export function relayRippleWheel(terminal: Terminal, event: WheelEvent) {
  const screen = terminal.element?.querySelector('.xterm-screen');
  if (!screen) return;
  const bounds = screen.getBoundingClientRect();
  screen.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      clientX: Math.max(bounds.left, Math.min(bounds.right - 1, event.clientX)),
      clientY: Math.max(bounds.top, Math.min(bounds.bottom - 1, event.clientY)),
    }),
  );
}
