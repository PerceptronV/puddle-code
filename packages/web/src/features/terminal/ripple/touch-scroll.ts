import type { Terminal } from '@xterm/xterm';
import { relayRippleWheel, rippleView } from './view';

/** Native DOM scrolling/selection in the reader; another swipe at its edge scrolls the CLI. */
export function attachRippleTouchScroll(
  element: HTMLElement,
  terminal: Terminal,
  onIntent: () => void,
): () => void {
  let gesture: {
    id: number;
    x: number;
    y: number;
    lastY: number;
    remainder: number;
    cellHeight: number;
    relayed: boolean;
  } | null = null;
  const start = (event: TouchEvent) => {
    gesture = null;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lastY: touch.clientY,
      remainder: 0,
      cellHeight: rippleView(terminal).cellHeight,
      relayed: false,
    };
    onIntent();
  };
  const move = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!gesture || event.touches.length !== 1 || touch?.identifier !== gesture.id) {
      gesture = null;
      return;
    }
    const delta = gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const vertical = Math.abs(touch.clientY - gesture.y);
    // Preserve horizontal code scrolling, pinch zoom and native text selection.
    if (vertical < 8 || vertical <= Math.abs(touch.clientX - gesture.x)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onIntent();
    const atEdge =
      delta < 0
        ? element.scrollTop <= 1
        : element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    if (!delta || !atEdge || !event.cancelable) return;
    event.preventDefault();
    gesture.relayed = true;
    gesture.remainder += delta;
    const rows = Math.trunc(gesture.remainder / gesture.cellHeight);
    gesture.remainder -= rows * gesture.cellHeight;
    for (let row = 0; row < Math.abs(rows); row++) {
      relayRippleWheel(
        terminal,
        new WheelEvent('wheel', {
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(rows),
          clientX: touch.clientX,
          clientY: touch.clientY,
        }),
      );
    }
  };
  const end = (event: TouchEvent) => {
    if (gesture?.relayed && event.cancelable) event.preventDefault();
    gesture = null;
  };
  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end, { passive: false });
  element.addEventListener('touchcancel', end);
  return () => {
    element.removeEventListener('touchstart', start);
    element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', end);
    element.removeEventListener('touchcancel', end);
  };
}
