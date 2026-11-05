import { flushSync } from 'react-dom';
import { reducedMotion } from '../../../lib/appearance/motion';
import './sidebar-motion.css';

let current: ViewTransition | undefined;

/** Capture individual visible counterparts, not a stretched image of a whole rail. */
function nameCounterparts(): () => void {
  const elements = new Map<string, HTMLElement>();
  for (const marker of document.querySelectorAll<HTMLElement>('[data-sidebar-motion]')) {
    const element = marker.querySelector<HTMLElement>('.status-glyph') ?? marker;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    let left = Math.max(0, rect.left);
    let right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top);
    let bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    if (left >= right || top >= bottom) continue;
    const key = marker.dataset.sidebarMotion!;
    // In narrow mode the overlay takes precedence over the rail underneath it.
    elements.set(key, element);
  }
  const restore: (() => void)[] = [];
  for (const [key, element] of elements) {
    const previous = element.style.viewTransitionName;
    const previousClass = element.style.getPropertyValue('view-transition-class');
    element.style.viewTransitionName = `sidebar-${Array.from(key, (char) => char.codePointAt(0)!.toString(16)).join('-')}`;
    element.style.setProperty('view-transition-class', 'sidebar-item');
    restore.push(() => {
      element.style.viewTransitionName = previous;
      element.style.setProperty('view-transition-class', previousClass);
    });
  }
  return () => restore.forEach((reset) => reset());
}

/** Animate explicit sidebar toggles without changing panel size persistence. */
export function animateSidebar(change: () => void) {
  if (!document.startViewTransition || reducedMotion()) {
    change();
    return;
  }
  // Finish a pending snapshot callback before applying the next toggle, so an
  // older callback cannot overwrite a newer request during rapid keyboard input.
  if (current) {
    current.skipTransition();
    void current.updateCallbackDone.then(() => flushSync(change)).catch(() => {});
    return;
  }
  document.documentElement.classList.add('sidebar-transition');
  const restoreBefore = nameCounterparts();
  const main = document.querySelector<HTMLElement>('[data-sidebar-main]');
  const before = main?.getBoundingClientRect();
  let mainAnimation: Animation | undefined;
  let restoreMain = () => {};
  let restoreAfter = () => {};
  const transition = document.startViewTransition(() => {
    restoreBefore();
    flushSync(change);
    if (main?.isConnected && before) {
      const after = main.getBoundingClientRect();
      const parent = main.parentElement!;
      const overflow = parent.style.overflow;
      parent.style.overflow = 'visible';
      restoreMain = () => {
        parent.style.overflow = overflow;
      };
      // Animate live layout dimensions: anchored controls and editor contents
      // reflow with the pane instead of stretching/cross-fading a screenshot.
      mainAnimation = main.animate(
        [
          {
            width: `${before.width}px`,
            height: `${before.height}px`,
            transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)`,
          },
          { width: `${after.width}px`, height: `${after.height}px`, transform: 'translate(0, 0)' },
        ],
        { duration: 280, easing: 'ease-out' },
      );
    }
    restoreAfter = nameCounterparts();
  });
  current = transition;
  void transition.finished
    .finally(() => {
      if (current !== transition) return;
      restoreBefore();
      restoreAfter();
      mainAnimation?.cancel();
      restoreMain();
      current = undefined;
      document.documentElement.classList.remove('sidebar-transition');
    })
    .catch(() => {});
}
