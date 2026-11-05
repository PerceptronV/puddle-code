import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { IslandResizeEdges } from './ui/island-resize-edges';
import { cn } from '../lib/utils';

/**
 * A draggable horizontal gutter that resizes the pane on one side of it — for
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
  height: number;
  min: number;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
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
        heightRef.current = Math.round(Math.min(max, Math.max(min, next)));
        setHeight(heightRef.current);
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const container =
      event.currentTarget.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const max = Math.max(min, container - 96);
    const step =
      (event.key === 'ArrowUp' ? -1 : 1) *
      (sized === 'below' ? -1 : 1) *
      (event.shiftKey ? 40 : 10);
    const next =
      event.key === 'Home'
        ? min
        : event.key === 'End'
          ? max
          : Math.min(max, Math.max(min, heightRef.current + step));
    heightRef.current = next;
    setHeight(next);
    try {
      localStorage.setItem(`${STORE_PREFIX}${id}`, String(next));
    } catch {
      /* Storage may be disabled. */
    }
  };
  return { height, handle: { dragging, height, min, onPointerDown, onKeyDown } };
}

/**
 * Empty resize gutter with shared, rounded facing-edge feedback.
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
  const ref = useRef<HTMLDivElement>(null);
  const [maximum, setMaximum] = useState(Math.max(handle.min, window.innerHeight - 96));
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const refresh = () =>
      setMaximum(Math.max(handle.min, parent.getBoundingClientRect().height - 96));
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [handle.min]);
  return (
    <>
      <div
        ref={ref}
        data-separator={handle.dragging ? 'active' : 'inactive'}
        role="separator"
        tabIndex={0}
        aria-valuenow={Math.min(maximum, handle.height)}
        aria-valuemax={maximum}
        aria-valuemin={handle.min}
        onKeyDown={handle.onKeyDown}
        aria-orientation="horizontal"
        aria-label={label}
        onPointerDown={handle.onPointerDown}
        className={cn(
          'relative h-[var(--ui-surface-gap)] shrink-0 cursor-row-resize touch-none bg-transparent',
          className,
        )}
      >
        <div className="absolute inset-x-0 top-1/2 h-[9px] -translate-y-1/2" />
      </div>
      <IslandResizeEdges separatorRef={ref} vertical={false} />
    </>
  );
}
