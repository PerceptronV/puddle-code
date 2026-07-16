/**
 * The puddle mark as an inline SVG so it inherits `currentColor` (the source
 * `public/puddle.svg` is a fixed brand colour). Stroke-only; size and colour
 * come from the caller's `className` — e.g. a large, muted empty-state glyph.
 */
export function PuddleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 2000 2000" fill="none" aria-hidden="true" className={className}>
      <g stroke="currentColor" strokeWidth={110} strokeLinecap="round" strokeLinejoin="round">
        <line x1="491.66" y1="1916.78" x2="1558.47" y2="83.22" />
        <path d="M491.66,1916.78c-329.28-191.58-441.36-613.07-250.32-941.41,191.04-328.34,612.84-439.21,942.13-247.62" />
        <path d="M1558.47,83.22c279.53,162.64,376.25,517.72,216.03,793.09-160.22,275.38-516.71,366.77-796.24,204.13" />
        <path d="M497.55,1881.96c-222.81-129.63-298.64-414.83-169.38-637,129.26-222.17,414.67-297.19,637.48-167.55" />
      </g>
    </svg>
  );
}
