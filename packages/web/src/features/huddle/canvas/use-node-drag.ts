import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import { movePosition, type Position } from './geometry';

interface Drag {
  id: string;
  pointer: number;
  captured: HTMLElement;
  origin: Position;
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
  version: number;
  moved: boolean;
}
export function useNodeDrag({
  viewport,
  zoom,
  version,
  locked,
  move,
  select,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  zoom: number;
  version: number;
  locked: boolean;
  move(id: string, position: Position, version: number): boolean;
  select(id: string): void;
}) {
  const skipClick = useRef(false);
  const active = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string; position: Position } | null>(null);
  const position = (drag: Drag, event: PointerEvent) =>
    movePosition(
      drag.origin,
      (event.clientX - drag.x + (viewport.current?.scrollLeft ?? 0) - drag.scrollX) / drag.zoom,
      (event.clientY - drag.y + (viewport.current?.scrollTop ?? 0) - drag.scrollY) / drag.zoom,
    );
  const cancel = () => {
    active.current = null;
    setPreview(null);
  };
  return {
    preview,
    cancel,
    suppressClick: () => {
      const skip = skipClick.current;
      skipClick.current = false;
      return skip;
    },
    handlers: (id: string, origin: Position) => ({
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || !event.isPrimary || locked) return;
        if (
          !event.currentTarget.contains(event.target as Node) ||
          (event.target as Element).closest('[data-huddle-socket], [data-node-control]')
        )
          return;
        event.stopPropagation();
        skipClick.current = false;
        (
          event.currentTarget.querySelector<HTMLElement>('[data-node-name]') ?? event.currentTarget
        ).focus({ preventScroll: true });
        const captured =
          (event.target as Element).closest<HTMLElement>('button') ?? event.currentTarget;
        captured.setPointerCapture(event.pointerId);
        active.current = {
          captured,
          id,
          origin,
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          scrollX: viewport.current?.scrollLeft ?? 0,
          scrollY: viewport.current?.scrollTop ?? 0,
          zoom,
          version,
          moved: false,
        };
        if (!(event.target as Element).closest('[data-node-identity]')) select(id);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const drag = active.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (locked || version !== drag.version) {
          cancel();
          return;
        }
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moved = true;
        skipClick.current = true;
        setPreview({ id, position: position(drag, event) });
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        const drag = active.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (drag.moved && !locked) move(id, position(drag, event), drag.version);
        cancel();
        if (drag.captured.hasPointerCapture(event.pointerId))
          drag.captured.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    }),
  };
}
