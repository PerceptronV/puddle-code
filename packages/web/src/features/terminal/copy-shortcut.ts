/** The subset of KeyboardEvent the copy-chord test needs (pure, unit-testable). */
export interface CopyKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The terminal's copy chord: ⌘C on Mac, Ctrl+Shift+C elsewhere (the
 * terminal-emulator convention — plain Ctrl-C is the interrupt on every
 * platform and must reach the PTY untouched).
 */
export function isCopyShortcut(e: CopyKeyEvent, isMac: boolean): boolean {
  if (e.type !== 'keydown') return false;
  if (isMac) return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'c';
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c';
}
