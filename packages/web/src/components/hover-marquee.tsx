import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * How fast a marquee travels, in CSS pixels per second — a CONSTANT SPEED, not a
 * constant duration. A fixed duration made every label finish together, so a
 * long path raced past while a barely-clipped one crawled; the same gesture read
 * differently depending on the content, which is exactly backwards for
 * legibility. Deriving the duration from the distance means every marquee in the
 * app moves at one readable pace, and a longer tail simply takes longer.
 */
const SPEED_PX_PER_S = 80;

/** Floor for a barely-clipped label, so a few pixels still animate rather than snap. */
const MIN_DURATION_MS = 180;

/** The travel time for a given overflow, at the app's one marquee speed. */
export function marqueeDurationMs(overflow: number): number {
  return Math.max(MIN_DURATION_MS, Math.round((overflow / SPEED_PX_PER_S) * 1000));
}

/**
 * A single-line label that eases its content leftwards to reveal the hidden tail
 * when a governing element is hovered — for too-long worktree paths / branch
 * names, changed-file paths, search results and session titles. It only animates
 * when the text actually overflows, and eases back out on leave.
 *
 * `hoverClass` names WHICH hover drives it and must be a LITERAL Tailwind class
 * at the call site (Tailwind only generates classes it can see in source) — e.g.
 * `group-hover/nav:[transform:translateX(var(--tail))]`. The `--tail` variable it
 * references is set here from the measured overflow.
 */
export function HoverMarquee({
  text,
  hoverClass,
  className,
  title,
}: {
  text: string;
  hoverClass: string;
  className?: string;
  /** Native tooltip (e.g. a row that shows a basename but knows the full path). */
  title?: string;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    // A span (blockified), not a div: these labels sit inside anchors and other
    // phrasing content — a session row's title line is a span inside a <Link> —
    // and as a flex item `block` behaves exactly as the div did.
    <span className="block min-w-0 flex-1 overflow-hidden">
      <span
        ref={spanRef}
        title={title}
        className={cn(
          'block whitespace-nowrap transition-transform ease-linear',
          className,
          overflow > 0 && hoverClass,
        )}
        style={
          overflow > 0
            ? ({
                '--tail': `-${overflow}px`,
                transitionDuration: `${marqueeDurationMs(overflow)}ms`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
