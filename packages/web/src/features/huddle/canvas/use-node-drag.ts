import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import { movePosition, type Position } from './geometry';

interface Drag {
  id: string;
  pointer: number;
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
    handlers: (id: string, origin: Position) => ({
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0 || !event.isPrimary || locked) return;
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        active.current = {
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
        select(id);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const drag = active.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (locked || version !== drag.version) {
          cancel();
          return;
        }
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moved = true;
        setPreview({ id, position: position(drag, event) });
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const drag = active.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (drag.moved && !locked) move(id, position(drag, event), drag.version);
        cancel();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    }),
  };
}
