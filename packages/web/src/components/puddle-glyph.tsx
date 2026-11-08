/**
 * The puddle mark as an inline SVG so it inherits `currentColor` (the source
 * `public/puddle.svg` is a fixed brand colour). Stroke-only; size and colour
 * come from the caller's `className` — e.g. a large, muted empty-state glyph.
 */
export function PuddleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 2000 2000" fill="none" aria-hidden="true" className={className}>
      <g stroke="currentColor" strokeWidth={120} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="1197.64" cy="716.31" r="615.6" />
        <line x1="925.58" y1="716.31" x2="925.58" y2="1529.88" />
        <path d="M925.58,1529.88c0,124.93-101.28,226.21-226.21,226.21-124.93,0-226.21-101.28-226.21-226.21s101.28-226.21,226.21-226.21c124.93,0,226.21,101.28,226.21,226.21Z" />
        <path d="M925.58,1529.88c0,204.02-165.39,369.41-369.41,369.41-204.02,0-369.41-165.39-369.41-369.41,0-204.02,165.39-369.41,369.41-369.41,204.02,0,369.41,165.39,369.41,369.41Z" />
        <circle cx="1197.64" cy="716.31" r="272.05" />
      </g>
    </svg>
  );
}
