import { expect, it } from 'vitest';
import {
  intersects,
  nodeBounds,
  viewportBounds,
  wireBounds,
} from '../../../src/features/huddle/canvas/visibility/bounds';

it('keeps partially visible tall nodes and excludes islands beyond the viewport', () => {
  const view = { x: 0, y: 0, right: 500, bottom: 300 };
  expect(intersects(nodeBounds({ x: -239, y: 299 }, 0, 0), view)).toBe(true);
  expect(intersects(nodeBounds({ x: -241, y: 299 }, 0, 0), view)).toBe(false);
  expect(intersects(nodeBounds({ x: 10, y: -1500 }, 64, 1), view)).toBe(true);
  expect(intersects(nodeBounds({ x: 10, y: -1500 }, 1, 64), view)).toBe(true);
  expect(intersects(nodeBounds({ x: 10, y: -1500 }, 1, 1), view)).toBe(false);
});

it('retains crossing wires and curved backward routes with both sockets off screen', () => {
  const view = { x: 0, y: 0, right: 100, bottom: 100 };
  expect(intersects(wireBounds({ x: -200, y: 50 }, { x: 200, y: 50 }), view)).toBe(true);
  // The backward curve bends into view although neither endpoint is inside.
  expect(intersects(wireBounds({ x: -10, y: 50 }, { x: -20, y: 50 }), view)).toBe(true);
  expect(intersects(wireBounds({ x: 110, y: 50 }, { x: 120, y: 50 }), view)).toBe(true);
  expect(intersects(wireBounds({ x: -200, y: 50 }, { x: -300, y: 50 }), view)).toBe(false);
  expect(intersects(wireBounds({ x: 10, y: 101 }, { x: 20, y: 101 }), view)).toBe(false);
});

it('uses actual scroll/size with screen-space overscan at every zoom and no hidden area', () => {
  const element = { scrollLeft: 300, scrollTop: 100, clientWidth: 500, clientHeight: 300 };
  expect(viewportBounds(element, 2)).toEqual({ x: 50, y: -50, right: 500, bottom: 300 });
  expect(viewportBounds(element, 0.001)).toEqual({
    x: 100_000,
    y: -100_000,
    right: 1_000_000,
    bottom: 600_000,
  });
  expect(viewportBounds({ ...element, clientWidth: 0 }, 1)).toBeNull();
  expect(intersects(nodeBounds({ x: 0, y: 0 }, 1, 1), null)).toBe(false);
});
