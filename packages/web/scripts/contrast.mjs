/** WCAG 2.x contrast maths, shared by check-tokens.mjs and its unit tests. */

/** '#RGB' | '#RRGGBB' | '#RRGGBBAA' → [r, g, b] in 0–255. Alpha is ignored. */
export function parseHex(hex) {
  const raw = hex.trim().replace(/^#/, '');
  const digits =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
}

/** WCAG relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, ≥ 1. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}
