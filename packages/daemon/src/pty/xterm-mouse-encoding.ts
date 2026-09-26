/**
 * addon-serialize 0.14.0 saves mouse tracking but omits its encoding. After
 * attach, SGR wheel/drag reports then become legacy binary events instead.
 * Read the exact-pinned xterm 6.0.0 state so combined/split mode sequences,
 * encoding changes and terminal resets retain the emulator's own semantics.
 * Keep this until the pinned serialiser restores mouse encoding itself.
 */
export function serialiseXtermMouseEncoding(terminal: unknown): string {
  const core = (terminal as { _core?: unknown })._core;
  const mouse = (core as { coreMouseService?: unknown } | undefined)?.coreMouseService;
  const encoding = (mouse as { activeEncoding?: unknown } | undefined)?.activeEncoding;
  switch (encoding) {
    case 'DEFAULT':
      return ''; // Snapshots are replayed into a reset terminal.
    case 'SGR':
      return '\x1b[?1006h';
    case 'SGR_PIXELS':
      return '\x1b[?1016h';
    default:
      throw new Error('xterm mouse encoding internals do not match the pinned 6.0.0 release');
  }
}
