import { useLayoutEffect, useRef, type RefObject } from 'react';

/** A single hover surface follows pointer/focus, including nested scrolling rows. */
export function useHoverSurface(
  surfaceRef: RefObject<HTMLElement | null>,
  { selector = 'button', direct = true }: { selector?: string; direct?: boolean } = {},
) {
  const markerRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const marker = markerRef.current;
    if (!surface || !marker) return;
    let placed = false;
    let hovered: EventTarget | null = null;
    let point: { x: number; y: number } | null = null;
    let observed: HTMLElement | null = null;
    const resize = new ResizeObserver(() => refresh());
    resize.observe(surface);
    const show = (target: EventTarget | null) => {
      const item = target instanceof Element ? target.closest<HTMLElement>(selector) : null;
      if (
        !item ||
        !surface.contains(item) ||
        (direct && item.parentElement !== surface) ||
        item.matches(':disabled')
      ) {
        marker.style.opacity = '0';
        return;
      }
      if (observed !== item) {
        if (observed) resize.unobserve(observed);
        observed = item;
        resize.observe(item);
      }
      const bounds = surface.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      const scaleX = bounds.width / surface.offsetWidth || 1;
      const scaleY = bounds.height / surface.offsetHeight || 1;
      if (!placed) marker.style.transition = 'none';
      marker.style.width = `${rect.width / scaleX}px`;
      marker.style.height = `${rect.height / scaleY}px`;
      marker.style.transform = `translate(${(rect.left - bounds.left) / scaleX + surface.scrollLeft}px, ${(rect.top - bounds.top) / scaleY + surface.scrollTop}px)`;
      marker.style.borderRadius = getComputedStyle(item).borderRadius;
      // Retain geometry when selection masks hover, so the next movement still
      // begins at the last slot instead of restarting at the container's origin.
      const selected = item.matches(
        '[aria-current="page"], [aria-selected="true"], [aria-pressed="true"], [data-state="open"], [data-session-active="true"]',
      );
      marker.style.opacity = selected ? '0' : '1';
      if (!placed) {
        void marker.offsetWidth;
        marker.style.transition = '';
        placed = true;
      }
    };
    const refresh = () =>
      show(hovered ?? (surface.contains(document.activeElement) ? document.activeElement : null));
    const events = new AbortController();
    const options = { signal: events.signal };
    surface.addEventListener(
      'pointermove',
      (event) => {
        point = { x: event.clientX, y: event.clientY };
      },
      options,
    );
    surface.addEventListener(
      'pointerover',
      (event) => {
        hovered = event.target;
        point = { x: event.clientX, y: event.clientY };
        refresh();
      },
      options,
    );
    surface.addEventListener(
      'pointerleave',
      () => {
        hovered = null;
        point = null;
        refresh();
      },
      options,
    );
    surface.addEventListener('focusin', refresh, options);
    surface.addEventListener('focusout', (event) => show(event.relatedTarget), options);
    surface.addEventListener(
      'scroll',
      () => {
        if (point) hovered = document.elementFromPoint(point.x, point.y);
        refresh();
      },
      options,
    );
    const mutations = new MutationObserver(refresh);
    mutations.observe(surface, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'aria-current',
        'aria-selected',
        'aria-pressed',
        'data-state',
        'data-session-active',
        'disabled',
      ],
    });
    return () => {
      events.abort();
      mutations.disconnect();
      resize.disconnect();
    };
  }, [surfaceRef, selector, direct]);
  return markerRef;
}

export function useTrayHover(trayRef: RefObject<HTMLElement | null>) {
  return useHoverSurface(trayRef);
}
