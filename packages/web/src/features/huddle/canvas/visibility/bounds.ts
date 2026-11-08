import type { HuddleBounds } from '../../view/camera';
import { NODE_WIDTH, WIRE_BEND, type Position } from '../geometry';

export function intersects(a: HuddleBounds, b: HuddleBounds | null): boolean {
  return !!b && a.x <= b.right && a.right >= b.x && a.y <= b.bottom && a.bottom >= b.y;
}

/** Conservative bounds include padding, header and the larger port column. */
export function nodeBounds(position: Position, inputs: number, outputs: number): HuddleBounds {
  return {
    ...position,
    right: position.x + NODE_WIDTH,
    bottom: position.y + 90 + 24 * Math.max(inputs, outputs),
  };
}

/** A cubic stays within its control-point hull, even when both endpoints are off screen. */
export function wireBounds(from: Position, to: Position): HuddleBounds {
  return {
    x: Math.min(from.x, to.x - WIRE_BEND, to.x),
    right: Math.max(from.x, from.x + WIRE_BEND, to.x),
    y: Math.min(from.y, to.y),
    bottom: Math.max(from.y, to.y),
  };
}

export function viewportBounds(
  element: Pick<HTMLElement, 'scrollLeft' | 'scrollTop' | 'clientWidth' | 'clientHeight'>,
  zoom: number,
): HuddleBounds | null {
  if (!element.clientWidth || !element.clientHeight) return null;
  // Screen-space overscan covers fast panning, island outlines and non-scaling wire hit areas.
  const margin = 200;
  return {
    x: (element.scrollLeft - margin) / zoom,
    y: (element.scrollTop - margin) / zoom,
    right: (element.scrollLeft + element.clientWidth + margin) / zoom,
    bottom: (element.scrollTop + element.clientHeight + margin) / zoom,
  };
}
