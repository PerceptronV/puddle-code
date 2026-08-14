import { describe, expect, it } from 'vitest';
import { initialCockpitBounds } from '../src/window-bounds';

describe('desktop cockpit launch bounds', () => {
  it('bottom-aligns a preferred-size macOS window in a slightly taller work area', () => {
    expect(initialCockpitBounds('darwin', { x: 0, y: 29, width: 1440, height: 903 })).toEqual({
      x: 0,
      y: 32,
      width: 1440,
      height: 900,
    });
  });

  it('clamps to a smaller macOS work area and meets every edge', () => {
    expect(initialCockpitBounds('darwin', { x: 10, y: 24, width: 1280, height: 780 })).toEqual({
      x: 10,
      y: 24,
      width: 1280,
      height: 780,
    });
  });

  it('keeps non-macOS launch sizing independent of display geometry', () => {
    expect(initialCockpitBounds('linux')).toEqual({ width: 1440, height: 900 });
  });
});
