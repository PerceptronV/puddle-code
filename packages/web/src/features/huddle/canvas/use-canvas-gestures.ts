import { bindZoomIntent } from '../../../lib/input/zoom-intent';
import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react';
import type { HuddleCameraBinding } from '../view/camera';

type Point = { x: number; y: number };
const centre = (points: Point[]) => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});
const distance = (points: Point[]) =>
  points.length < 2 ? 1 : Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);

/** Background drag/swipe, two-finger pan/pinch, and trackpad/Command-wheel zoom. */
export function useCanvasGestures(
  viewport: RefObject<HTMLDivElement | null>,
  camera: RefObject<HuddleCameraBinding | null>,
  cancelEditingGesture: () => void,
) {
  const pointers = useRef(new Map<number, Point>());
  const panning = useRef(false);
  const pinched = useRef(false);
  const pinchAnchor = useRef<Point>({ x: 0, y: 0 });
  const intent = useRef<ReturnType<typeof bindZoomIntent> | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const guard = bindZoomIntent(element.ownerDocument.defaultView!);
    intent.current = guard;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const mode = guard.wheel(event);
      if (mode === 'ignore' || pointers.current.size > 1) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (mode === 'zoom') {
        const rect = element.getBoundingClientRect();
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        camera.current?.gesture(Math.exp(-event.deltaY * unit * 0.005), anchor, anchor);
      } else {
        camera.current?.gesture(
          1,
          { x: 0, y: 0 },
          {
            x: -(event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit,
            y: event.shiftKey && !event.deltaX ? 0 : -event.deltaY * unit,
          },
        );
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
      guard.dispose();
      intent.current = null;
    };
  }, [viewport, camera]);
  const point = (event: PointerEvent) => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pinched.current) event.stopPropagation();
    if (!pointers.current.size) {
      panning.current = false;
      event.currentTarget.style.cursor = '';
    }
  };
  return {
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      if (![0, 1].includes(event.button)) return;
      if (!pointers.current.size) pinched.current = false;
      pointers.current.set(event.pointerId, point(event));
      const background = !(event.target as Element).closest('button, [data-huddle-node]');
      if (pointers.current.size >= 2) {
        if (!pinched.current) pinchAnchor.current = centre([...pointers.current.values()]);
        pinched.current = true;
        cancelEditingGesture();
      }
      if (background || pinched.current || event.button === 1) {
        event.preventDefault();
        event.stopPropagation();
        panning.current = true;
        event.currentTarget.style.cursor = 'grabbing';
        event.currentTarget.setPointerCapture(event.pointerId);
        if (background) event.currentTarget.focus({ preventScroll: true });
      }
    },
    onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
      if (!pointers.current.has(event.pointerId)) return;
      const before = [...pointers.current.values()];
      pointers.current.set(event.pointerId, point(event));
      if (!panning.current) return;
      event.preventDefault();
      event.stopPropagation();
      const after = [...pointers.current.values()];
      if (pinched.current) {
        intent.current?.suppressPan();
        if (after.length >= 2)
          camera.current?.gesture(
            distance(after) / Math.max(1, distance(before)),
            pinchAnchor.current,
            pinchAnchor.current,
          );
      } else if (!event.metaKey && !event.ctrlKey && !intent.current?.panBlocked()) {
        camera.current?.gesture(1, centre(before), centre(after));
      }
    },
    onPointerUpCapture: finish,
    onPointerCancelCapture: finish,
    onLostPointerCaptureCapture: finish,
    onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
      if (pinched.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (event.target !== event.currentTarget) return;
      const delta = {
        ArrowLeft: [64, 0],
        ArrowRight: [-64, 0],
        ArrowUp: [0, 64],
        ArrowDown: [0, -64],
      }[event.key];
      if (delta) {
        event.preventDefault();
        camera.current?.gesture(1, { x: 0, y: 0 }, { x: delta[0]!, y: delta[1]! });
      }
    },
  };
}
