import { describe, expect, it } from 'vitest';
import { pdfPagePoint } from '../src/features/editor/pdf-coordinates';

describe('pdfPagePoint', () => {
  const bounds = { left: 100, top: 50, width: 400, height: 600 };

  it('maps fitted CSS coordinates to top-left PDF big points', () => {
    expect(pdfPagePoint(300, 350, bounds, 612, 792)).toEqual({ x: 306, y: 396 });
  });

  it('clamps pointer rounding at page edges', () => {
    expect(pdfPagePoint(99, 49, bounds, 612, 792)).toEqual({ x: 0, y: 0 });
    expect(pdfPagePoint(501, 651, bounds, 612, 792)).toEqual({ x: 612, y: 792 });
  });

  it('rejects unmeasurable pages', () => {
    expect(pdfPagePoint(100, 50, { ...bounds, width: 0 }, 612, 792)).toBeNull();
    expect(pdfPagePoint(100, 50, bounds, 0, 792)).toBeNull();
  });
});
