export interface TerminalScrollPosition {
  /** Absolute buffer line shown at the top of the viewport. */
  viewportY: number;
  /** Follow newly appended output instead of pinning an old buffer line. */
  atBottom: boolean;
}

function keyFor(stream: string, term: string): string {
  return JSON.stringify([stream, term]);
}

function bufferLine(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Capture a terminal viewport without trusting out-of-range buffer values. */
export function terminalScrollPosition(viewportY: number, baseY: number): TerminalScrollPosition {
  const safeBase = bufferLine(baseY);
  const safeViewport = Math.min(safeBase, bufferLine(viewportY));
  return { viewportY: safeViewport, atBottom: safeViewport >= safeBase };
}

/** Resolve a saved viewport against the scrollback that is available now. */
export function terminalScrollLine(position: TerminalScrollPosition, baseY: number): number {
  const safeBase = bufferLine(baseY);
  return position.atBottom ? safeBase : Math.min(position.viewportY, safeBase);
}

/**
 * Browser-window terminal viewport state. Terminals normally remain mounted in
 * the keep-alive host, but this also survives a workspace route remount. It is
 * deliberately client-local and bounded: scroll position is view state, not a
 * daemon/protocol concern, and closed sessions must not leak entries forever.
 */
export class TerminalScrollStore {
  private readonly positions = new Map<string, TerminalScrollPosition>();

  constructor(private readonly maxEntries = 500) {}

  set(stream: string, term: string, viewportY: number, baseY: number): TerminalScrollPosition {
    const key = keyFor(stream, term);
    const position = terminalScrollPosition(viewportY, baseY);
    // Refresh insertion order so active terminals are the last to be evicted.
    this.positions.delete(key);
    this.positions.set(key, position);
    while (this.positions.size > this.maxEntries) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
    return position;
  }

  get(stream: string, term: string): TerminalScrollPosition | undefined {
    return this.positions.get(keyFor(stream, term));
  }
}

export const terminalScrollStore = new TerminalScrollStore();
