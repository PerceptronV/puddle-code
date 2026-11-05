import type { Terminal } from '@xterm/xterm';

interface XtermCore {
  coreService: { decPrivateModes: { synchronizedOutput: boolean } };
}

const patchedTerminals = new WeakSet<Terminal>();

/**
 * xterm 6.0.0 ends every synchronised update with a full-viewport refresh, even
 * when only the cursor attributes changed. Its render service already retains
 * dirty ranges across writes and flushes them on the next refresh after reset.
 * Request just the cursor row here; parsing and cursor movement still contribute
 * their dirty rows, and the native safety timeout remains in charge of an update
 * whose closing sequence never arrives. Remove when the pinned release fixes it.
 */
export function preserveXtermSynchronisedDirtyRows(terminal: Terminal): void {
  if (patchedTerminals.has(terminal)) return;
  const core = (terminal as unknown as { _core?: XtermCore })._core;
  if (typeof core?.coreService?.decPrivateModes?.synchronizedOutput !== 'boolean') {
    throw new Error('xterm synchronised output internals do not match the pinned 6.0.0 release');
  }
  patchedTerminals.add(terminal);
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    // Compound resets may switch buffers or change other modes. Leave those on
    // the native path, including its full redraw, rather than reinterpret them.
    if (params.length !== 1 || params[0] !== 2026) return false;
    core.coreService.decPrivateModes.synchronizedOutput = false;
    const buffer = terminal.buffer.active;
    const cursorRow = Math.min(terminal.rows - 1, buffer.baseY + buffer.cursorY - buffer.viewportY);
    terminal.refresh(cursorRow, cursorRow);
    return true;
  });
}
