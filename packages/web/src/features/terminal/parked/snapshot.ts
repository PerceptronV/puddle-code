import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';

export interface ParkedTerminalSnapshot {
  data: Uint8Array;
  cols: number;
  rows: number;
  viewportY: number;
  cursorStyle: Terminal['options']['cursorStyle'];
}

// A failed optimisation must retain the original viewer, never truncate history.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** The pinned serialiser omits OSC 8 targets and can mis-style alternate buffers. */
function hasUnsupportedState(terminal: Terminal): boolean {
  const core = (
    terminal as unknown as {
      _core?: { _oscLinkService?: { _dataByLinkId?: Map<number, unknown> } };
    }
  )._core;
  const links = core?._oscLinkService?._dataByLinkId;
  return (
    !(links instanceof Map) ||
    links.size > 0 ||
    terminal.buffer.active.type === 'alternate' ||
    terminal.modes.synchronizedOutputMode
  );
}

/**
 * A local, read-only fallback until a fresh canonical replay arrives. UTF-8 bytes
 * avoid retaining the serialiser's large tree of intermediate JavaScript strings.
 * The snapshot never leaves this browser component or enters persistent storage.
 */
export function captureParkedTerminal(terminal: Terminal): ParkedTerminalSnapshot | null {
  if (terminal.hasSelection() || hasUnsupportedState(terminal)) return null;
  const serialiser = new SerializeAddon();
  terminal.loadAddon(serialiser);
  try {
    const text = serialiser.serialize();
    if (text.length > MAX_SNAPSHOT_BYTES) return null;
    const core = (terminal as unknown as { _core: { coreService: { isCursorHidden: boolean } } })
      ._core;
    const data = new TextEncoder().encode(
      text + (core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h'),
    );
    if (data.byteLength > MAX_SNAPSHOT_BYTES) return null;
    return {
      data,
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY,
      cursorStyle: terminal.options.cursorStyle,
    };
  } finally {
    serialiser.dispose();
  }
}

export function restoreParkedTerminal(
  terminal: Terminal,
  snapshot: ParkedTerminalSnapshot,
): Promise<void> {
  terminal.options.cursorStyle = snapshot.cursorStyle;
  return new Promise((resolve) =>
    terminal.write(snapshot.data, () => {
      terminal.scrollToLine(snapshot.viewportY);
      resolve();
    }),
  );
}
