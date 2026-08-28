/** A point measured in PDF big points (72 dpi) from the visible page's top-left. */
export interface PdfPagePoint {
  x: number;
  y: number;
}

/**
 * Converts a pointer position on a fitted PDF canvas to the coordinates
 * accepted by SyncTeX. `pageWidth` / `pageHeight` are the PDF.js viewport at
 * scale 1, whose units are big points. The ratio keeps the result correct when
 * CSS rounds a fitted canvas to a fractional pixel.
 */
export function pdfPagePoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  pageWidth: number,
  pageHeight: number,
): PdfPagePoint | null {
  if (bounds.width <= 0 || bounds.height <= 0 || pageWidth <= 0 || pageHeight <= 0) {
    return null;
  }

  const localX = clamp(clientX - bounds.left, 0, bounds.width);
  const localY = clamp(clientY - bounds.top, 0, bounds.height);
  return {
    x: (localX / bounds.width) * pageWidth,
    y: (localY / bounds.height) * pageHeight,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
