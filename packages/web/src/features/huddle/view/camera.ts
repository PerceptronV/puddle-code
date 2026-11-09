import type { HuddleCamera } from './state';

export interface HuddleGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface HuddleBounds {
  x: number;
  y: number;
  right: number;
  bottom: number;
}
export interface HuddleCameraBinding {
  geometry(value: HuddleGeometry): void;
  zoom(value: number): void;
  gesture(scale: number, from: { x: number; y: number }, to: { x: number; y: number }): void;
  fit(bounds: HuddleBounds): void;
  dispose(): void;
}

/** Logical coordinates survive origin changes; viewport clamping never replaces the desired view. */
export function bindHuddleCamera(
  element: HTMLElement,
  geometry: HuddleGeometry,
  initial: HuddleCamera | null,
  remember: (camera: HuddleCamera) => void,
  zoomChanged: (zoom: number) => void,
): HuddleCameraBinding {
  let camera = initial ?? { x: geometry.left, y: geometry.top, zoom: 1 };
  let applied = { left: element.scrollLeft, top: element.scrollTop };
  let size = '';
  const dimensions = () =>
    [element.clientWidth, element.clientHeight, element.scrollWidth, element.scrollHeight].join(
      ':',
    );
  const visible = () => element.clientWidth > 0 && element.clientHeight > 0;
  const apply = () => {
    if (!visible()) return;
    size = dimensions();
    element.scrollLeft = (camera.x - geometry.left) * camera.zoom;
    element.scrollTop = (camera.y - geometry.top) * camera.zoom;
    applied = { left: element.scrollLeft, top: element.scrollTop };
  };
  const capture = () => {
    if (!visible()) return;
    // Resize can clamp and dispatch scroll before ResizeObserver runs.
    if (size !== dimensions()) {
      apply();
      return;
    }
    if (element.scrollLeft === applied.left && element.scrollTop === applied.top) return;
    camera = {
      zoom: camera.zoom,
      x: element.scrollLeft / camera.zoom + geometry.left,
      y: element.scrollTop / camera.zoom + geometry.top,
    };
    applied = { left: element.scrollLeft, top: element.scrollTop };
    remember(camera);
  };
  const update = (value: HuddleCamera) => {
    camera = value;
    remember(camera);
    zoomChanged(camera.zoom);
    // React updates scaled dimensions next; the subsequent geometry call reapplies too.
    apply();
  };
  apply();
  element.addEventListener('scroll', capture, { passive: true });
  const observer = new ResizeObserver(apply);
  observer.observe(element);
  return {
    geometry: (value) => {
      geometry = value;
      apply();
    },
    zoom: (value) => {
      if (!Number.isFinite(value)) return;
      capture();
      update({ ...camera, zoom: Math.min(2, Math.max(0.001, value)) });
    },
    gesture: (scale, from, to) => {
      if (!Number.isFinite(scale) || scale <= 0) return;
      capture();
      const zoom = Math.min(2, Math.max(0.001, camera.zoom * scale));
      update({
        zoom,
        x: camera.x + from.x / camera.zoom - to.x / zoom,
        y: camera.y + from.y / camera.zoom - to.y / zoom,
      });
    },
    fit: (bounds) => {
      if (!visible()) return;
      const zoom = Math.min(
        2,
        Math.max(
          0.001,
          Math.min(
            (element.clientWidth - 64) / Math.max(1, bounds.right - bounds.x),
            (element.clientHeight - 64) / Math.max(1, bounds.bottom - bounds.y),
          ),
        ),
      );
      update({
        zoom,
        x: bounds.x - (element.clientWidth / zoom - (bounds.right - bounds.x)) / 2,
        y: bounds.y - (element.clientHeight / zoom - (bounds.bottom - bounds.y)) / 2,
      });
    },
    dispose: () => {
      capture();
      observer.disconnect();
      element.removeEventListener('scroll', capture);
    },
  };
}
