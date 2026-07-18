import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * A single-line label that eases its content leftwards to reveal the hidden tail
 * when a governing element is hovered — for too-long worktree paths / branch
 * names in the left sidebar. It only animates when the text actually overflows,
 * and eases back out on leave.
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
    <div className="min-w-0 flex-1 overflow-hidden">
      <span
        ref={spanRef}
        title={title}
        className={cn(
          'block whitespace-nowrap transition-transform duration-[900ms] ease-linear',
          className,
          overflow > 0 && hoverClass,
        )}
        style={overflow > 0 ? ({ '--tail': `-${overflow}px` } as React.CSSProperties) : undefined}
      >
        {text}
      </span>
    </div>
  );
}
