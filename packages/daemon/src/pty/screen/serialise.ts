import type { Terminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { serialiseXtermMouseEncoding } from '../xterm-mouse-encoding.js';
import { SCREEN_LIMITS } from './limits.js';

/**
 * Bound the exact-pinned 0.14.0 ANSI serialiser before it builds its row strings.
 * Each cell contributes at most six JSON bytes per UTF-16 character, including
 * arbitrarily long combined characters. Styled cells and their following reset
 * receive 128 bytes for SGR (both RGB colours and all nine flags); null runs get
 * two cursor/erase commands. A row receives cursor/erase/wrap fix-up space too.
 * These deliberately overestimate the upstream StringSerializeHandler, which
 * emits neither OSC hyperlinks nor HTML. Revalidate with the paired xterm bump.
 */
export function screenScrollback(
  terminal: Terminal,
  maximum = SCREEN_LIMITS.snapshotBytes,
): number {
  let remaining = maximum - 4096; // Modes, final cursor/style and mouse encoding.
  if (remaining < 0) throw new Error('Terminal viewport exceeds snapshot capacity');
  const rowBytes = (buffer: Terminal['buffer']['normal'], index: number): number => {
    const line = buffer.getLine(index);
    if (!line) return 128;
    let bytes = 128 + (buffer.getLine(index + 1)?.isWrapped ? line.length + 128 : 0);
    const cell = buffer.getNullCell();
    let styled = false;
    let empty = false;
    for (let column = 0; column < line.length; column++) {
      if (!line.getCell(column, cell) || cell.getWidth() === 0) continue;
      const text = cell.getChars();
      const nextStyled = !cell.isAttributeDefault();
      if (styled || nextStyled) bytes += 128;
      styled = nextStyled;
      if (text === '') {
        if (!empty) bytes += 64;
        empty = true;
      } else {
        bytes += text.length * 6;
        empty = false;
      }
      if (bytes > remaining) return bytes;
    }
    return bytes;
  };
  if (terminal.buffer.active.type === 'alternate') {
    const alternate = terminal.buffer.alternate;
    for (let row = 0; row < alternate.length; row++) {
      remaining -= rowBytes(alternate, row);
      if (remaining < 0) throw new Error('Terminal viewport exceeds snapshot capacity');
    }
  }
  const normal = terminal.buffer.normal;
  const required = Math.min(normal.length, terminal.rows);
  let selected = 0;
  for (let row = normal.length - 1; row >= 0; row--) {
    const bytes = rowBytes(normal, row);
    if (bytes > remaining) {
      if (selected < required) throw new Error('Terminal viewport exceeds snapshot capacity');
      break;
    }
    remaining -= bytes;
    selected++;
    if (selected >= terminal.rows + SCREEN_LIMITS.scrollbackLines) break;
  }
  return Math.max(0, selected - terminal.rows);
}

/** Reduce whole old scrollback lines, never the visible buffers or an ANSI suffix. */
export function serialiseScreen(
  terminal: Terminal,
  serialiser: SerializeAddon,
  maximum = SCREEN_LIMITS.snapshotBytes,
): string {
  const scrollback = screenScrollback(terminal, maximum);
  const data = serialiser.serialize({ scrollback }) + serialiseXtermMouseEncoding(terminal);
  // Defence against an upstream implementation change; preflight is the allocation bound.
  if (Buffer.byteLength(JSON.stringify(data)) > maximum)
    throw new Error('Terminal serialiser exceeded its preflight bound');
  return data;
}
