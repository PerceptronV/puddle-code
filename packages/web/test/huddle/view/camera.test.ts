import { afterEach, expect, it, vi } from 'vitest';
import { bindHuddleCamera } from '../../../src/features/huddle/view/camera';

function viewport() {
  let resize!: () => void;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  class View extends EventTarget {
    clientWidth = 500;
    clientHeight = 300;
    scrollWidth = 2000;
    scrollHeight = 1400;
    private left = 0;
    private top = 0;
    get scrollLeft() {
      return this.left;
    }
    set scrollLeft(value: number) {
      this.left = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, value));
    }
    get scrollTop() {
      return this.top;
    }
    set scrollTop(value: number) {
      this.top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));
    }
  }
  const element = new View();
  return {
    element,
    dom: element as unknown as HTMLElement,
    resize: () => resize(),
    scroll: () => element.dispatchEvent(new Event('scroll')),
  };
}
afterEach(() => vi.unstubAllGlobals());
const geometry = { left: -32, top: -32, width: 2000, height: 1400 };

it('restores logical positions and preserves the view when source bounds change', () => {
  const v = viewport(),
    save = vi.fn();
  const binding = bindHuddleCamera(v.dom, geometry, { x: 400, y: 200, zoom: 0.5 }, save, vi.fn());
  expect(v.element.scrollLeft).toBe(216);
  expect(v.element.scrollTop).toBe(116);
  binding.geometry({ ...geometry, left: -200, top: -100 });
  expect(v.element.scrollLeft).toBe(300);
  expect(v.element.scrollTop).toBe(150);
  v.scroll();
  expect(save).not.toHaveBeenCalled();
  v.element.scrollLeft = 400;
  v.scroll();
  expect(save).toHaveBeenLastCalledWith({ x: 600, y: 200, zoom: 0.5 });
  binding.dispose();
});
it('does not replace desired camera with resize clamping or hidden-pane zeros', () => {
  const v = viewport(),
    save = vi.fn();
  const binding = bindHuddleCamera(v.dom, geometry, { x: 1200, y: 800, zoom: 1 }, save, vi.fn());
  v.element.clientWidth = 1800;
  const previousLeft = v.element.scrollLeft;
  v.element.scrollLeft = previousLeft;
  v.scroll();
  v.resize();
  expect(v.element.scrollLeft).toBe(200);
  v.element.clientWidth = 500;
  v.resize();
  expect(v.element.scrollLeft).toBe(1232);
  v.element.clientHeight = 0;
  v.element.scrollTop = 0;
  v.scroll();
  v.element.clientHeight = 300;
  v.resize();
  expect(v.element.scrollTop).toBe(832);
  binding.dispose();
  expect(save).not.toHaveBeenCalled();
});
it('captures the final scroll on teardown and records zoom/fit without asynchronous callbacks', () => {
  const v = viewport(),
    save = vi.fn(),
    zoom = vi.fn();
  const binding = bindHuddleCamera(v.dom, geometry, null, save, zoom);
  v.element.scrollLeft = 300;
  v.element.scrollTop = 200;
  binding.zoom(0.8);
  expect(save).toHaveBeenLastCalledWith({ x: 268, y: 168, zoom: 0.8 });
  expect(zoom).toHaveBeenLastCalledWith(0.8);
  binding.fit({ x: 100, y: 100, right: 340, bottom: 190 });
  expect(zoom.mock.lastCall![0]).toBeGreaterThan(0.8);
  binding.zoom(Infinity);
  expect(zoom).toHaveBeenCalledTimes(2);
  v.element.scrollLeft = 300;
  binding.dispose();
  expect(save.mock.lastCall![0].x).toBeGreaterThan(100);
});
