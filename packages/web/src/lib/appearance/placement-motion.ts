import { reducedMotion } from './motion';

let pending = 0;
const running = new Set<Animation>();
export const placementMotionPending = () => pending > 0;

/** Animate live destinations after a drop, keeping the actual layout authoritative. */
export function animatePlacement(
  change: () => void,
  source: DOMRect | undefined,
  destination: () => HTMLElement | null,
) {
  if (reducedMotion() || !source) {
    change();
    return;
  }
  for (const animation of running) animation.cancel();
  running.clear();
  const before = new Map(
    [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')]
      .filter((element) => !element.closest('[data-motion-snapshot]'))
      .map((element) => [element.dataset.workspacePane, element.getBoundingClientRect()]),
  );
  pending++;
  try {
    change();
  } finally {
    requestAnimationFrame(() => {
      pending--;
      if (reducedMotion()) return;
      const target = destination();
      if (!target) return;
      const pane = target.closest<HTMLElement>('[data-workspace-pane]');
      const animate = (element: HTMLElement, from: DOMRect, genie: boolean) => {
        const to = element.getBoundingClientRect();
        if (!to.width || !to.height) return;
        const x = from.left - to.left;
        const y = from.top - to.top;
        const sx = Math.max(0.02, from.width / to.width);
        const sy = Math.max(0.02, from.height / to.height);
        const animation = element.animate(
          (genie
            ? [
                {
                  transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`,
                  opacity: 0.4,
                  offset: 0,
                },
                {
                  transform: `translate(${x * 0.25}px, ${y * 0.35}px) scale(${sx + (1 - sx) * 0.85}, ${sy + (1 - sy) * 0.5})`,
                  opacity: 1,
                  offset: 0.55,
                },
                { transform: 'none', opacity: 1, offset: 1 },
              ]
            : [
                {
                  transform: `translate(${x}px, ${y}px)`,
                  width: `${from.width}px`,
                  height: `${from.height}px`,
                },
                { transform: 'none', width: `${to.width}px`, height: `${to.height}px` },
              ]
          ).map((frame) => ({ ...frame, transformOrigin: 'top left' })),
          { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
        );
        // Set on the effect so existing author styles need no restoration.
        animation.effect?.updateTiming({ fill: 'none' });
        running.add(animation);
        void animation.finished.then(
          () => running.delete(animation),
          () => running.delete(animation),
        );
      };
      // Existing panes settle into their new geometry while the dropped content
      // unfurls from the source row/chip. No copied editor controls or PTYs.
      for (const element of document.querySelectorAll<HTMLElement>('[data-workspace-pane]')) {
        if (element.closest('[data-motion-snapshot]')) continue;
        const from = before.get(element.dataset.workspacePane);
        if (element === pane && !from) animate(element, source, true);
        else if (from) {
          const to = element.getBoundingClientRect();
          if (
            from.x !== to.x ||
            from.y !== to.y ||
            from.width !== to.width ||
            from.height !== to.height
          )
            animate(element, from, false);
        }
      }
      if (pane && target !== pane && before.has(pane.dataset.workspacePane))
        animate(target, source, true);
      const observer = new MutationObserver(() => {
        if (reducedMotion()) for (const animation of running) animation.cancel();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-reduce-motion'],
      });
      void Promise.allSettled([...running].map((animation) => animation.finished)).then(() =>
        observer.disconnect(),
      );
    });
  }
}
