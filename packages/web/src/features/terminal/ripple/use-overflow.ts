import { useLayoutEffect, type RefObject } from 'react';
import type { RippleSnapshot } from './buffer';

/** Omit older complete blocks before clipping the row adjacent to native output. */
export function useRippleOverflow(
  viewport: RefObject<HTMLDivElement | null>,
  snapshot: RippleSnapshot,
  active: boolean,
) {
  useLayoutEffect(() => {
    const element = viewport.current;
    const content = element?.firstElementChild as HTMLElement | null;
    if (!active || !element || !content) return;
    const hidden = new Map<HTMLElement, string>();
    const restore = () => {
      for (const [node, display] of hidden) node.style.display = display;
      hidden.clear();
    };
    const hide = (node: HTMLElement) => {
      if (!hidden.has(node)) hidden.set(node, node.style.display);
      node.style.display = 'none';
    };
    let previous = '';
    const measure = () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      const signature = () => `${width}:${height}:${content.getBoundingClientRect().height}`;
      if (signature() === previous) return;
      restore();
      const prose = content.querySelector<HTMLElement>('.ripple-prose');
      if (!prose) return;
      // Preserve Markdown context and existing source spans. Re-parsing a shorter
      // source prefix can turn a list continuation or tool output into prose.
      const blocks: HTMLElement[] = [];
      const collect = (node: HTMLElement) => {
        if (node.classList.contains('ripple-text') || node.matches('ul,ol')) {
          for (const child of node.children) collect(child as HTMLElement);
        } else if (!node.matches('[data-ripple-summary]')) blocks.push(node);
      };
      for (const child of prose.children) collect(child as HTMLElement);
      const fits = () => content.getBoundingClientRect().height <= height + 0.5;
      // Keep the latest block and pinned prompt; older output is the fallback
      // sacrifice when fixed typography cannot fit above a manually high split.
      const older = blocks.slice(0, -1);
      const omit = (count: number) => {
        restore();
        for (const block of older.slice(0, count)) {
          hide(block);
          const parent = block.parentElement;
          if (
            parent?.matches('ul,ol') &&
            [...parent.children].every((child) => hidden.has(child as HTMLElement))
          )
            hide(parent);
        }
      };
      if (!fits()) {
        // Bound synchronous layout reads even for a dense terminal viewport.
        let low = 1;
        let high = older.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          omit(middle);
          if (fits()) high = middle;
          else low = middle + 1;
        }
        omit(low);
      }
      previous = signature();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(content);
    document.addEventListener('selectionchange', measure);
    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', measure);
      restore();
    };
  }, [viewport, snapshot, active]);
}
