import { useLayoutEffect, useRef } from 'react';

/** Fit the full rail abbreviation, capped at the ordinary label size. */
export function ProjectAbbreviation({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = box.current!;
    const probe = measure.current!;
    const visible = label.current!;
    const fit = () => {
      // Computed layout widths retain fractions and ignore sidebar transforms.
      const available = parseFloat(getComputedStyle(container).width);
      const natural = parseFloat(getComputedStyle(probe).width);
      if (available > 0 && natural > 0) {
        visible.style.fontSize = `${Math.min(1, available / natural)}em`;
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(probe); // also catches UI font changes and font loading
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={box} className="relative block whitespace-nowrap">
      <span
        ref={measure}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 w-max"
      >
        {text}
      </span>
      <span ref={label} className="inline-block" data-project-abbreviation>
        {text}
      </span>
    </span>
  );
}
