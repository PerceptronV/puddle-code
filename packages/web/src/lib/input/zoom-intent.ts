/** Keep inertial pan events out of a zoom gesture, including modifier-key gaps. */
export function bindZoomIntent(target: Window) {
  let modifier = false;
  let zoomUntil = 0;
  const suppressPan = () => {
    zoomUntil = performance.now() + 180;
  };
  const key = (event: KeyboardEvent) => {
    modifier = event.metaKey || event.ctrlKey;
  };
  const blur = () => {
    modifier = false;
    zoomUntil = 0;
  };
  target.addEventListener('keydown', key);
  target.addEventListener('keyup', key);
  target.addEventListener('blur', blur);
  return {
    suppressPan,
    panBlocked: () => modifier || performance.now() < zoomUntil,
    wheel(event: WheelEvent): 'zoom' | 'pan' | 'ignore' {
      if (event.metaKey || event.ctrlKey) {
        suppressPan();
        return 'zoom';
      }
      return modifier || performance.now() < zoomUntil ? 'ignore' : 'pan';
    },
    dispose() {
      target.removeEventListener('keydown', key);
      target.removeEventListener('keyup', key);
      target.removeEventListener('blur', blur);
    },
  };
}
