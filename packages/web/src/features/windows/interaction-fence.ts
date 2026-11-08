const events = ['keydown', 'keyup', 'beforeinput', 'pointerdown', 'drop'] as const;
const block = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

/** Inert content plus capture-phase fencing for document-level workspace shortcuts. */
export function fenceWindowInteraction(active: boolean): void {
  const root = document.getElementById('root');
  if (root) root.inert = active;
  for (const type of events) {
    if (active) window.addEventListener(type, block, true);
    else window.removeEventListener(type, block, true);
  }
  if (active && document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
