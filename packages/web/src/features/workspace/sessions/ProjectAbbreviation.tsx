import { useLayoutEffect, useRef } from 'react';

/** Give every project the smallest size needed to fit any abbreviation in this rail. */
export function useProjectAbbreviationSize(labelsKey: string) {
  const rail = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rail.current!;
    const probes = [...root.querySelectorAll<HTMLElement>('[data-project-abbreviation-measure]')];
    const fit = () => {
      let scale = 1;
      for (const probe of probes) {
        // Computed layout widths retain fractions and ignore sidebar transforms.
        const available = parseFloat(getComputedStyle(probe.parentElement!).width);
        const natural = parseFloat(getComputedStyle(probe).width);
        if (available > 0 && natural > 0) scale = Math.min(scale, available / natural);
      }
      root.style.setProperty('--project-abbreviation-size', `${scale}em`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    for (const probe of probes) {
      observer.observe(probe.parentElement!);
      observer.observe(probe); // also catches UI font changes and font loading
    }
    return () => observer.disconnect();
  }, [labelsKey]);

  return rail;
}

export function ProjectAbbreviation({ text }: { text: string }) {
  return (
    <span className="relative block whitespace-nowrap">
      <span
        data-project-abbreviation-measure
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 w-max"
      >
        {text}
      </span>
      <span
        className="inline-block"
        data-project-abbreviation
        style={{ fontSize: 'var(--project-abbreviation-size, 1em)' }}
      >
        {text}
      </span>
    </span>
  );
}
