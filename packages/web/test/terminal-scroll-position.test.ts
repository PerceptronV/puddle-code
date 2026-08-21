import { describe, expect, it } from 'vitest';
import {
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
