import type { Terminal } from '@xterm/xterm';
import { rippleInputBorder, rippleInputMarker } from './agent-layout';

/** Keep the real composer visible without resizing or moving the underlying PTY. */
export function rippleView(
  terminal: Terminal,
  agentType?: string,
  nativeRows: number | null = null,
) {
  const buffer = terminal.buffer.active;
  const first = buffer.viewportY;
  let occupiedRows = terminal.rows;
  if (buffer.type === 'normal' && first === buffer.baseY && agentType) {
    // Ink-style CLIs leave unused rows below a short conversation. Move that
    // empty tail offscreen instead of reserving it as part of the input area.
    let end = terminal.rows;
    while (
      end > 0 &&
      !buffer
        .getLine(first + end - 1)
        ?.translateToString(true)
        .trim()
    )
      end--;
    // Keep one breathing row after the footer, whether the CLI parks its cursor
    // there or moves it back into the composer while editing.
    end = Math.max(buffer.cursorY + 1, Math.min(terminal.rows, end + 1));
    if (end >= 6) occupiedRows = end;
  }
  let firstCol = 0;
  let lastCol = terminal.cols;
  if (agentType === 'opencode') {
    // The input's lower border ends at the conversation pane's right edge.
    // Keep OpenCode's optional sidebar out of the flowing transcript.
    for (let row = first + terminal.rows - 1; row >= first + Math.floor(terminal.rows / 2); row--) {
      const border = /^(\s*)╹(▀{8,})/.exec(buffer.getLine(row)?.translateToString(true) ?? '');
      if (!border) continue;
      firstCol = border[1]!.length;
      lastCol = border[0].length;
      break;
    }
  }
  let composer = Math.max(0, occupiedRows - 5);
  let foundComposer = false;
  if (
    agentType &&
    buffer.baseY + buffer.cursorY >= first &&
    buffer.baseY + buffer.cursorY < first + terminal.rows
  ) {
    // Search near the cursor, not the bottom half of the screen: normal-buffer
    // CLIs can place a short conversation's input high in an otherwise empty pane.
    const cursor = Math.min(first + terminal.rows - 1, buffer.baseY + buffer.cursorY);
    const earliest =
      buffer.type === 'alternate'
        ? first + Math.floor(terminal.rows / 2)
        : Math.max(first, cursor - Math.max(12, Math.floor(terminal.rows / 2)));
    for (let row = cursor; row >= earliest; row--) {
      const line = buffer.getLine(row);
      if (!rippleInputMarker(line?.translateToString(true) ?? '', agentType)) continue;
      foundComposer = true;
      composer = row - first;
      if (agentType === 'opencode') {
        // OpenCode has a left border through the whole input panel rather than
        // a prompt glyph. Find its top from the cursor's row, not reply boxes.
        while (
          composer > 0 &&
          rippleInputMarker(
            buffer.getLine(first + composer - 1)?.translateToString(true) ?? '',
            agentType,
          )
        )
          composer--;
      }
      // Include the composer's top padding when it carries the same backing.
      const above = buffer.getLine(first + composer - 1);
      if (
        rippleInputBorder(above?.translateToString(true) ?? '', agentType) ||
        (above &&
          !above.translateToString(true).trim() &&
          above.getCell(0)?.getBgColorMode() === line?.getCell(0)?.getBgColorMode() &&
          above.getCell(0)?.getBgColor() === line?.getCell(0)?.getBgColor())
      )
        composer--;
      break;
    }
  }
  if (!foundComposer) {
    occupiedRows = terminal.rows;
    composer = Math.max(0, terminal.rows - 5);
  }
  if (nativeRows !== null) composer = Math.max(3, occupiedRows - nativeRows);
  composer = Math.max(0, Math.min(occupiedRows - 1, composer));
  let last = first + composer;
  // Codex's scroll hint belongs to its controls, not the answer being read.
  if (agentType === 'codex' || agentType === 'gemini-cli') {
    while (last > first) {
      const text =
        buffer
          .getLine(last - 1)
          ?.translateToString(true)
          .trim() ?? '';
      const hint =
        agentType === 'codex'
          ? /^(?:New activity\s*·\s*)?↓\s*Back to bottom\b/.test(text)
          : /^(?:Shift\+Tab to |\? for shortcuts$)/i.test(text) ||
            rippleInputBorder(text, agentType);
      if (text && !hint) break;
      last--;
    }
  }
  if (agentType === 'gemini-cli' && buffer.type === 'alternate') {
    // Gemini paints its own scrollbar in the last column. Treat it as UI only
    // when that entire conversation gutter consists of blanks and thumb cells.
    const gutter = Array.from(
      { length: last - first },
      (_, row) =>
        buffer
          .getLine(first + row)
          ?.getCell(terminal.cols - 1)
          ?.getChars() ?? '',
    );
    if (gutter.some((text) => /[▄█▀]/.test(text)) && gutter.every((text) => /^[ ▄█▀]*$/.test(text)))
      lastCol--;
  }
  const screen = terminal.element?.querySelector('.xterm-screen');
  const cellHeight = (screen?.getBoundingClientRect().height || terminal.rows * 16) / terminal.rows;
  return {
    first,
    last,
    firstCol,
    lastCol,
    nativeRows: occupiedRows - composer,
    cellHeight,
    bottom: Math.max(0, occupiedRows - composer) * cellHeight,
    nativeOffset: (terminal.rows - occupiedRows) * cellHeight,
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
