import type { TabRef } from '@puddle/shared';
import { animatePlacement } from '../../../lib/appearance/placement-motion';
import { tabRefKey } from './layout-tree';

let nativeSource: DOMRect | undefined;

/** One capture listener covers file-tree rows and both session sidebar modes. */
export function trackNativePlacementSource() {
  const start = (event: DragEvent) => {
    const target = event.target;
    nativeSource =
      target instanceof Element
        ? target.closest<HTMLElement>('[draggable="true"]')?.getBoundingClientRect()
        : undefined;
  };
  const end = () => {
    nativeSource = undefined;
  };
  window.addEventListener('dragstart', start, true);
  window.addEventListener('dragend', end);
  return () => {
    window.removeEventListener('dragstart', start, true);
    window.removeEventListener('dragend', end);
    end();
  };
}

export function animateTabPlacement(
  change: () => void,
  ref: TabRef,
  toLeafId: string,
  source = nativeSource,
) {
  const previous = new Set(
    [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')].map(
      (element) => element.dataset.workspacePane,
    ),
  );
  animatePlacement(change, source, () => {
    const candidates = [...document.querySelectorAll<HTMLElement>('[data-pane-view]')].filter(
      (element) =>
        element.dataset.paneView === tabRefKey(ref) && !element.closest('[data-motion-snapshot]'),
    );
    return (
      candidates.find(
        (element) =>
          !previous.has(
            element.closest<HTMLElement>('[data-workspace-pane]')?.dataset.workspacePane,
          ),
      ) ??
      candidates.find(
        (element) =>
          element.closest<HTMLElement>('[data-workspace-pane]')?.dataset.workspacePane === toLeafId,
      ) ??
      null
    );
  });
}
