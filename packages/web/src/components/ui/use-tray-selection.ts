import { useLayoutEffect, useRef } from 'react';

const positions = new Map<string, { x: number; y: number; width: number; height: number }>();

/** One magnetic selection marker, shared by horizontal and vertical trays. */
export function useTraySelection(vertical: boolean, label: string) {
  const trayRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const tray = trayRef.current;
    const marker = markerRef.current;
    if (!tray || !marker) return;
    const key = `${label}:${vertical ? 'vertical' : 'horizontal'}`;
    const previous = positions.get(key);
    if (previous) {
      marker.hidden = false;
      marker.style.transition = 'none';
      marker.style.width = `${previous.width}px`;
      marker.style.height = `${previous.height}px`;
      marker.style.transform = `translate(${previous.x}px, ${previous.y}px)`;
      void marker.offsetWidth;
      marker.style.transition = '';
    }
    const buttons = () => [...tray.querySelectorAll<HTMLButtonElement>(':scope > button')];
    let drag: { id: number; start: number; moved: boolean; target: HTMLButtonElement } | null =
      null;
    let suppressClick = false;
    const show = (button?: HTMLButtonElement) => {
      tray.toggleAttribute('data-sliding-selection', !!button);
      marker.hidden = !button;
      for (const slot of buttons())
        slot.toggleAttribute('data-selection-highlight', slot === button);
      if (!button) return;
      const bounds = tray.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      positions.set(key, {
        x: rect.left - bounds.left,
        y: rect.top - bounds.top,
        width: rect.width,
        height: rect.height,
      });
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
      marker.style.transform = `translate(${rect.left - bounds.left}px, ${rect.top - bounds.top}px)`;
    };
    const refresh = () =>
      show(
        drag?.target ?? buttons().find((button) => button.getAttribute('aria-current') === 'page'),
      );
    const mutations = new MutationObserver(refresh);
    mutations.observe(tray, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-current'],
    });
    const resize = new ResizeObserver(refresh);
    resize.observe(tray);
    refresh();
    const events = new AbortController();
    const options = { signal: events.signal };
    tray.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return;
        const button = (event.target as Element).closest('button');
        if (
          !(button instanceof HTMLButtonElement) ||
          button.getAttribute('aria-current') !== 'page'
        )
          return;
        drag = {
          id: event.pointerId,
          start: vertical ? event.clientY : event.clientX,
          moved: false,
          target: button,
        };
      },
      options,
    );
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        const coordinate = vertical ? event.clientY : event.clientX;
        if (!drag.moved && Math.abs(coordinate - drag.start) < 4) return;
        drag.moved = true;
        tray.setAttribute('data-dragging-selection', '');
        tray.setPointerCapture(event.pointerId);
        const choices = buttons().filter(
          (button) => !button.disabled && button.hasAttribute('data-tray-slot'),
        );
        drag.target = choices.reduce((nearest, button) => {
          const distance = (slot: HTMLElement) => {
            const rect = slot.getBoundingClientRect();
            return Math.abs(
              coordinate - (vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2),
            );
          };
          return distance(button) < distance(nearest) ? button : nearest;
        }, drag.target);
        show(drag.target);
      },
      options,
    );
    const finish = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const { target, moved } = drag;
      drag = null;
      tray.removeAttribute('data-dragging-selection');
      if (tray.hasPointerCapture(event.pointerId)) tray.releasePointerCapture(event.pointerId);
      if (moved && event.type === 'pointerup') {
        suppressClick = true;
        target.click();
      }
      refresh();
    };
    document.addEventListener('pointerup', finish, options);
    document.addEventListener('pointercancel', finish, options);
    tray.addEventListener(
      'click',
      (event) => {
        if (!suppressClick || !event.isTrusted) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { ...options, capture: true },
    );
    return () => {
      events.abort();
      mutations.disconnect();
      resize.disconnect();
    };
  }, [vertical, label]);
  return { trayRef, markerRef };
}
