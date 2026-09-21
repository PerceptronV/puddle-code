import { describe, expect, it } from 'vitest';
import { touchModifiedInput } from '../src/features/terminal/touch-modifiers';

describe('touch terminal modifiers', () => {
  it('sends hardware-equivalent control and option chords', () => {
    expect(touchModifiedInput('c', 1)).toBe('\x03');
    expect(touchModifiedInput('D', 1)).toBe('\x04');
    expect(touchModifiedInput(' ', 1)).toBe('\x00');
    expect(touchModifiedInput('[', 1)).toBe('\x1b');
    expect(touchModifiedInput('b', 2)).toBe('\x1bb');
    expect(touchModifiedInput('c', 3)).toBe('\x1b\x03');
  });
  it('keeps Unicode intact and encodes modified arrow keys', () => {
    expect(touchModifiedInput('日本語 🌊', 0)).toBe('日本語 🌊');
    expect(touchModifiedInput('🌊', 1)).toBe('🌊');
    expect(touchModifiedInput('\x1b[D', 1)).toBe('\x1b[1;5D');
    expect(touchModifiedInput('\x1b[C', 2)).toBe('\x1b[1;3C');
    expect(touchModifiedInput('\x1b[A', 3)).toBe('\x1b[1;7A');
  });
});
