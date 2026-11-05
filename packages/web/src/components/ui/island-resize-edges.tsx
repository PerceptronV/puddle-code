import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './island-resize-edges.css';

/** Shared facing-edge feedback for panel dividers and standalone height handles. */
export function IslandResizeEdges({
  separatorRef: ref,
  vertical,
}: {
  separatorRef: RefObject<HTMLDivElement | null>;
  vertical: boolean;
}) {
  const [edges, setEdges] = useState<CSSProperties[]>([]);
  useEffect(() => {
    const separator = ref.current;
    if (!separator) return;
    const panels = [separator.previousElementSibling, separator.nextElementSibling];
    let frame = 0;

    const update = () => {
      const active =
        separator.matches(':hover, :focus-visible') || separator.dataset.separator === 'active';
      if (!active) {
        setEdges([]);
        return;
      }
      const next: CSSProperties[] = [];
      panels.forEach((panel, index) => {
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        const side = vertical ? (index === 0 ? 'right' : 'left') : index === 0 ? 'bottom' : 'top';
        const selector = '.workspace-surface.island-outline';
        const surfaces = [...panel.querySelectorAll<HTMLElement>(selector)];
        if (panel instanceof HTMLElement && panel.matches(selector)) surfaces.unshift(panel);
        for (const surface of surfaces) {
          const rect = surface.getBoundingClientRect();
          if (!rect.width || !rect.height || Math.abs(rect[side] - bounds[side]) > 1) continue;
          const radius = getComputedStyle(surface).borderRadius;
          // The mask keeps the facing edge solid and fades its rounded returns
          // into the existing top/bottom (or left/right) island outline.
          next.push({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            borderRadius: radius,
            maskImage: `linear-gradient(to ${side}, transparent calc(100% - 2 * ${parseFloat(radius) || 0}px), black)`,
          });
        }
      });
      setEdges(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    panels.forEach((panel) => {
      if (!panel) return;
      resize.observe(panel);
      panel
        .querySelectorAll('.workspace-surface.island-outline')
        .forEach((surface) => resize.observe(surface));
    });
    const state = new MutationObserver(schedule);
    state.observe(separator, { attributes: true, attributeFilter: ['data-separator'] });
    for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur'])
      separator.addEventListener(event, schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      state.disconnect();
      for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur'])
        separator.removeEventListener(event, schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [vertical, ref]);

  return createPortal(
    edges.map((style, index) => (
      <div key={index} aria-hidden className="island-resize-edge" style={style} />
    )),
    document.body,
  );
}
