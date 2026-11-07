import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  rippleCellAtOffset,
  relayRippleCell,
  type RippleSourceMap,
} from '../../../src/features/terminal/ripple/source-map';
import { rippleHtml } from '../../../src/features/terminal/ripple/markdown';
const map: RippleSourceMap = {
  cols: 80,
  viewport: 10,
  bufferType: 'alternate',
  rows: [
    { row: 10, start: 0, columns: [0, 2, 3, 3, 5, 5], text: '界 😀é' },
    { row: 11, start: 6, columns: [0, 1], text: 'ok' },
  ],
};
describe('Ripple terminal source anchors', () => {
  it('keeps wide glyphs, surrogate pairs, combining marks and soft wraps on their native cells', () => {
    expect(rippleCellAtOffset(map, 0)).toMatchObject({ row: 10, col: 0 });
    expect(rippleCellAtOffset(map, 2)).toMatchObject({ row: 10, col: 3 });
    expect(rippleCellAtOffset(map, 3)).toMatchObject({ row: 10, col: 3 });
    expect(rippleCellAtOffset(map, 5)).toMatchObject({ row: 10, col: 5 });
    expect(rippleCellAtOffset(map, 6)).toMatchObject({ row: 11, col: 0 });
    expect(rippleCellAtOffset(map, 8)).toBeNull();
  });
  it('rejects stale cells before dispatching any mouse events', () => {
    const anchor = rippleCellAtOffset(map, 0)!;
    const terminal = {
      cols: 80,
      modes: { mouseTrackingMode: 'vt200' },
      buffer: {
        active: {
          type: 'alternate',
          viewportY: 10,
          getLine: () => ({ translateToString: () => 'Changed row' }),
        },
      },
    } as unknown as Terminal;
    expect(relayRippleCell(terminal, anchor)).toBe(false);
    terminal.cols = 79;
    expect(relayRippleCell(terminal, anchor)).toBe(false);
  });
  it.each([
    '# Heading\n\nA **bold** and *italic* paragraph.',
    '- First\n- Second',
    '```ts\nconst x = 1;\n```',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
  ])('adds source ranges without changing Markdown structure: %s', (source) => {
    const plain = rippleHtml(source);
    const anchored = rippleHtml(source, false, false, { anchorText: true });
    const strip = (html: string) => html.replace(/<span[^>]*>|<\/span>/g, '');
    expect(strip(anchored)).toBe(plain);
  });
});
