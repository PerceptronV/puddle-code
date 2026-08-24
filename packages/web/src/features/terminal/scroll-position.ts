export interface TerminalScrollPosition {
  /** Absolute buffer line shown at the top of the viewport. */
  viewportY: number;
  /** Follow newly appended output instead of pinning an old buffer line. */
  atBottom: boolean;
}

export interface TerminalScrollAnchor extends TerminalScrollPosition {
  /** First buffer row of the logical (possibly wrapped) viewport line. */
  logicalLineY: number;
  /** Cell offset of the old viewport row within that logical line. */
  cellOffset: number;
}

function keyFor(stream: string, term: string): string {
  return JSON.stringify([stream, term]);
}

function bufferLine(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function terminalColumns(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
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
 * Capture the logical line at the top of a viewport before xterm reflows it.
 * Raw buffer indexes are not stable across a column change: every wrapped line
 * above the viewport can gain or lose rows.
 */
export function terminalScrollAnchor(
  viewportY: number,
  baseY: number,
  cols: number,
  isWrapped: (line: number) => boolean,
): TerminalScrollAnchor {
  const position = terminalScrollPosition(viewportY, baseY);
  let logicalLineY = position.viewportY;
  // Bottom-following terminals need no marker and may end inside an extremely
  // long wrapped output line, so avoid a pointless backwards scan for them.
  if (!position.atBottom) {
    while (logicalLineY > 0 && isWrapped(logicalLineY)) logicalLineY--;
  }
  return {
    ...position,
    logicalLineY,
    cellOffset: (position.viewportY - logicalLineY) * terminalColumns(cols),
  };
}

/** Resolve a tracked logical-line marker after xterm has reflowed the buffer. */
export function terminalReflowScrollLine(
  anchor: TerminalScrollAnchor,
  trackedLogicalLine: number | undefined,
  cols: number,
  baseY: number,
): number {
  const safeBase = bufferLine(baseY);
  if (anchor.atBottom) return safeBase;
  if (trackedLogicalLine === undefined || trackedLogicalLine < 0) {
    return terminalScrollLine(anchor, safeBase);
  }
  const reflowedLine =
    bufferLine(trackedLogicalLine) + Math.floor(anchor.cellOffset / terminalColumns(cols));
  return Math.min(reflowedLine, safeBase);
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
