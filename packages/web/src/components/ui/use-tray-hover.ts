import { useLayoutEffect, useRef, type RefObject } from 'react';

/** A single hover surface follows the pointer/focus between a tray's buttons. */
export function useTrayHover(trayRef: RefObject<HTMLElement | null>) {
  const markerRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const tray = trayRef.current;
    const marker = markerRef.current;
    if (!tray || !marker) return;
    let placed = false;
    const show = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest('button') : null;
      if (
        !button ||
        !tray.contains(button) ||
        button.parentElement !== tray ||
        button.disabled ||
        button.getAttribute('aria-current') === 'page' ||
        button.getAttribute('aria-pressed') === 'true' ||
        button.dataset.state === 'open'
      ) {
        marker.style.opacity = '0';
        return;
      }
      const bounds = tray.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      if (!placed) marker.style.transition = 'none';
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
      marker.style.transform = `translate(${rect.left - bounds.left}px, ${rect.top - bounds.top}px)`;
      marker.style.borderRadius = getComputedStyle(button).borderRadius;
      marker.style.opacity = '1';
      if (!placed) {
        void marker.offsetWidth;
        marker.style.transition = '';
        placed = true;
      }
    };
    const events = new AbortController();
    const options = { signal: events.signal };
    tray.addEventListener('pointerover', (event) => show(event.target), options);
    tray.addEventListener('pointerleave', () => show(null), options);
    tray.addEventListener('focusin', (event) => show(event.target), options);
    tray.addEventListener('focusout', (event) => show(event.relatedTarget), options);
    return () => events.abort();
  }, [trayRef]);
  return markerRef;
}
