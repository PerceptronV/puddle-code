import { describe, expect, it } from 'vitest';
import {
  terminalReflowScrollLine,
  terminalScrollAnchor,
  terminalScrollLine,
  terminalScrollPosition,
  TerminalScrollStore,
} from '../src/features/terminal/scroll-position';

describe('terminal scroll position', () => {
  it('pins a deliberately scrolled viewport while new output extends the buffer', () => {
    const position = terminalScrollPosition(32, 80);
    expect(position).toEqual({ viewportY: 32, atBottom: false });
    expect(terminalScrollLine(position, 120)).toBe(32);
  });

  it('keeps a bottom-following viewport at the new bottom', () => {
    const position = terminalScrollPosition(80, 80);
    expect(position).toEqual({ viewportY: 80, atBottom: true });
    expect(terminalScrollLine(position, 120)).toBe(120);
  });

  it('clamps a saved line when older scrollback is no longer available', () => {
    expect(terminalScrollLine({ viewportY: 80, atBottom: false }, 40)).toBe(40);
    expect(terminalScrollPosition(-5, 20)).toEqual({ viewportY: 0, atBottom: false });
    expect(terminalScrollPosition(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      viewportY: 0,
      atBottom: true,
    });
  });

  it('tracks the same wrapped transcript line when a narrower grid inserts rows', () => {
    const wrapped = new Set([25]);
    const anchor = terminalScrollAnchor(25, 71, 35, (line) => wrapped.has(line));

    expect(anchor).toEqual({
      viewportY: 25,
      atBottom: false,
      logicalLineY: 24,
      cellOffset: 35,
    });
    // xterm's marker follows logical line 24 to line 36 during reflow. The
    // original top row then starts one 20-column row into that logical line.
    expect(terminalReflowScrollLine(anchor, 36, 20, 111)).toBe(37);
  });

  it('tracks the same wrapped transcript line when a wider grid removes rows', () => {
    const wrapped = new Set([40, 41]);
    const anchor = terminalScrollAnchor(41, 111, 20, (line) => wrapped.has(line));

    expect(anchor.logicalLineY).toBe(39);
    expect(anchor.cellOffset).toBe(40);
    // The logical-line marker moves to 26 and the old cell remains in its
    // second 35-column row, rather than retaining the meaningless raw row 41.
    expect(terminalReflowScrollLine(anchor, 26, 35, 71)).toBe(27);
  });

  it('continues following the bottom and safely falls back if an anchor was trimmed', () => {
    const bottom = terminalScrollAnchor(80, 80, 120, () => {
      throw new Error('bottom-following terminals do not need a wrapped-line scan');
    });
    expect(terminalReflowScrollLine(bottom, undefined, 80, 120)).toBe(120);

    const pinned = terminalScrollAnchor(32, 80, 120, () => false);
    expect(terminalReflowScrollLine(pinned, undefined, 80, 120)).toBe(32);
  });
});

describe('TerminalScrollStore', () => {
  it('scopes positions by PTY identity and evicts the least recently set entry', () => {
    const store = new TerminalScrollStore(2);
    store.set('session-1', 'agent', 10, 20);
    store.set('session-1', 'shell-1', 4, 8);
    store.set('session-1', 'agent', 11, 20);
    store.set('session-2', 'agent', 3, 9);

    expect(store.get('session-1', 'agent')).toEqual({ viewportY: 11, atBottom: false });
    expect(store.get('session-1', 'shell-1')).toBeUndefined();
    expect(store.get('session-2', 'agent')).toEqual({ viewportY: 3, atBottom: false });
  });
});
