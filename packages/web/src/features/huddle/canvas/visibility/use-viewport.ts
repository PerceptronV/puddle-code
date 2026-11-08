import { useLayoutEffect, useState, type RefObject } from 'react';
import type { HuddleBounds, HuddleGeometry } from '../../view/camera';
import { viewportBounds } from './bounds';

/** Observe the actual clamped viewport, independently of the persisted desired camera. */
export function useGraphViewport(
  ref: RefObject<HTMLDivElement | null>,
  zoom: number,
  { left, top, width, height }: HuddleGeometry,
) {
  const [bounds, setBounds] = useState<HuddleBounds | null>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    let frame: number | undefined;
    const read = () => {
      frame = undefined;
      const next = viewportBounds(element, zoom);
      setBounds((previous) =>
        previous?.x === next?.x &&
        previous?.y === next?.y &&
        previous?.right === next?.right &&
        previous?.bottom === next?.bottom
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(read);
    };
    read();
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [ref, zoom, left, top, width, height]);
  return bounds;
}
