import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '../lib/utils';

/**
 * A draggable horizontal border that resizes the pane on one side of it — for
 * the two places a full `react-resizable-panels` Group would be the wrong tool:
 * a disclosure that only exists while it is open (the session sidebar's
 * Archived pane) and a section inside a navigator that has no panel context
 * (the Changes navigator's History). Both simply need their own height.
 *
 * The size is CLIENT scope, like the other per-browser sizes: `localStorage`,
 * keyed by an id the caller picks, so it survives a reload without touching the
 * profile's `ui_state` (nothing here belongs to the profile — these are one
 * window's furniture). Height is stored in pixels but always rendered under a
 * container-relative cap, so a value dragged tall in a big window cannot squash
 * the pane it shares in a small one.
 */

const STORE_PREFIX = 'puddle.pane-height.';

/** The stored pixel height for `id`, or null when absent/corrupt/unavailable. */
function storedHeight(id: string): number | null {
  try {
    const raw = localStorage.getItem(`${STORE_PREFIX}${id}`);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // storage disabled — the initial height is good enough
  }
}

export interface HeightHandle {
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * @param sized which side of the handle the resized pane is on — `below` means
 * dragging UP makes it taller (the archived disclosure), `above` means dragging
 * DOWN does (a section over its sibling).
 */
export function useResizableHeight(
  id: string,
  initial: number,
  { sized, min = 64 }: { sized: 'above' | 'below'; min?: number },
): { height: number; handle: HeightHandle } {
  const [height, setHeight] = useState(() => storedHeight(id) ?? initial);
  const [dragging, setDragging] = useState(false);
  const heightRef = useRef(height);
  heightRef.current = height;

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Left button only, and never let the gesture start a text selection or a
      // native drag in the list the handle sits against.
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      const startY = e.clientY;
      const startHeight = heightRef.current;
      // Leave the sibling something to live in: the cap comes from the flex
      // container the handle sits in, not the viewport.
      const container = el.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
      const max = Math.max(min, container - 96);
      el.setPointerCapture(e.pointerId);
      setDragging(true);
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        const next = sized === 'below' ? startHeight - dy : startHeight + dy;
        setHeight(Math.round(Math.min(max, Math.max(min, next))));
      };
      const done = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', done);
        el.removeEventListener('pointercancel', done);
        setDragging(false);
        try {
          localStorage.setItem(`${STORE_PREFIX}${id}`, String(heightRef.current));
        } catch {
          // Storage disabled: the drag still applied, it just won't be remembered.
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', done);
      el.addEventListener('pointercancel', done);
    },
    [id, min, sized],
  );

  return { height, handle: { dragging, onPointerDown } };
}

/**
 * The border itself: a hairline that colours on hover and while dragging, with
 * an invisible 9px grab band around it (a 1px target is unhittable). No box, no
 * grip dots — the cursor is the affordance (HUMANS.md).
 */
export function HeightHandle({
  handle,
  label,
  className,
}: {
  handle: HeightHandle;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={handle.onPointerDown}
      className={cn(
        'relative h-px shrink-0 cursor-row-resize touch-none bg-border transition-colors hover:bg-accent',
        handle.dragging && 'bg-accent',
        className,
      )}
    >
      <div className="absolute inset-x-0 -top-1 h-[9px]" />
    </div>
  );
}
