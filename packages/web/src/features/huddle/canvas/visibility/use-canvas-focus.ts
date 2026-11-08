import { useState, type FocusEvent } from 'react';

/** Pin the focused island/socket or SVG wire while the viewport moves away from it. */
export function useCanvasFocus() {
  const [focused, setFocused] = useState<{ node?: string; edge?: string }>({});
  const read = (root: Element, target: EventTarget | null) => {
    const element = target instanceof Element && root.contains(target) ? target : null;
    const node =
      element?.closest('[data-huddle-node]')?.getAttribute('data-huddle-node') ?? undefined;
    const edge =
      element?.closest('[data-huddle-edge]')?.getAttribute('data-huddle-edge') ?? undefined;
    setFocused((previous) =>
      previous.node === node && previous.edge === edge ? previous : { node, edge },
    );
  };
  return {
    focused,
    handlers: {
      onFocusCapture: (event: FocusEvent<HTMLDivElement>) =>
        read(event.currentTarget, event.target),
      onBlurCapture: (event: FocusEvent<HTMLDivElement>) =>
        read(event.currentTarget, event.relatedTarget),
    },
  };
}
