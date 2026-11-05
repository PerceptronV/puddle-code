import { describe, expect, it } from 'vitest';
import {
  sameProjection,
  type Projection,
} from '../../../src/features/terminal/rich-output/projection';
import { terminalRichBlocks } from '../../../src/features/terminal/rich-output/rich-output-buffer';
import { bufferWithLines } from '../../helpers/terminal-buffer';

function projection(text: string): Projection {
  const buffer = bufferWithLines(
    text.split('\n').map((text) => ({ text })),
    80,
  );
  return {
    blocks: terminalRichBlocks(buffer, 80, 0, 24),
    viewportY: 0,
    buffer: 'normal',
    width: 800,
    cellWidth: 10,
    cellHeight: 20,
    fontSize: 14,
  };
}

describe('rich-output projection identity', () => {
  it('ignores ordinary spinner changes while detecting completed and rewritten blocks', () => {
    expect(sameProjection(projection('Working |'), projection('Working /'))).toBe(true);
    const open = projection('```mermaid\nflowchart TB\nA --> B');
    const complete = projection('```mermaid\nflowchart TB\nA --> B\n```');
    expect(sameProjection(open, complete)).toBe(false);
    expect(sameProjection(complete, structuredClone(complete))).toBe(true);
    expect(sameProjection(complete, projection('```mermaid\nflowchart TB\nA --> C\n```'))).toBe(
      false,
    );
    expect(sameProjection(complete, projection('rewritten prompt'))).toBe(false);
  });
  it('invalidates placement, viewport, font, buffer and geometry changes', () => {
    const original = projection('$x^2$');
    for (const patch of [
      { viewportY: 1 },
      { buffer: 'alternate' },
      { width: 700 },
      { cellWidth: 9 },
      { cellHeight: 21 },
      { fontSize: 16 },
    ]) {
      expect(sameProjection(original, { ...original, ...patch })).toBe(false);
    }
    expect(sameProjection(original, projection(' $x^2$'))).toBe(false);
    expect(sameProjection(original, projection('$$x^2$$'))).toBe(false);
  });
});
