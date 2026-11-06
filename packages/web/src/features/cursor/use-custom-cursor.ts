import { useEffect, type RefObject } from 'react';

// Computed cursor styles are no longer useful after a custom package's global
// `cursor: none` rule applies, so identify the native hand/edit targets by
// structure instead.
const INTERACTIVE_TARGETS =
  'a, button, [role="button"], [role="slider"], input, select, textarea, summary, label, [onclick], .cursor-pointer';
const EDITOR_TARGET = '.monaco-editor';

export type StructuralCursorRole = 'default' | 'interactive' | 'text';

/** Monaco outranks its internal clickable/gutter nodes: the editor is one text surface. */
export function structuralCursorRole(
  target: Pick<Element, 'closest'> | null,
  noCaretTargets: string,
): StructuralCursorRole {
  if (target?.closest(EDITOR_TARGET) && !target.closest(noCaretTargets)) return 'text';
  if (target?.closest(INTERACTIVE_TARGETS)) return 'interactive';
  return 'default';
}

export function useCustomCursor(
  ref: RefObject<HTMLDivElement | null>,
  noCaretTargets = '.no-custom-caret',
): void {
  useEffect(() => {
    const cursor = ref.current;
    if (!cursor) return;
    const finePointer = window.matchMedia('(pointer: fine)');

    let frame = 0;
    let point: { x: number; y: number; target: Element | null } | null = null;
    let cachedTarget: Element | null = null;
    let dirty = true;
    let hitTest = false;
    const observer = new MutationObserver(() => invalidate());

    const schedule = () => {
      if (point && !frame) frame = requestAnimationFrame(render);
    };
    const invalidate = () => {
      dirty = true;
      hitTest = true;
      schedule();
    };
    const hide = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      point = null;
      cachedTarget = null;
      dirty = true;
      observer.disconnect();
      cursor.style.opacity = '0';
    };

    const render = () => {
      frame = 0;
      if (!point) return;
      const { x, y } = point;
      const target = hitTest ? document.elementFromPoint(x, y) : point.target;
      point.target = target;
      hitTest = false;
      // An embedded document owns its own cursor and sends no further moves
      // here. Do not leave our cursor stranded over it.
      if (target instanceof HTMLIFrameElement || !finePointer.matches) {
        hide();
        return;
      }
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      cursor.style.opacity = '1';
      if (!dirty && target === cachedTarget) return;
      dirty = false;
      cachedTarget = target;
      observer.disconnect();
      // Watch only the hovered node and its ancestry, not every terminal
      // row elsewhere in the document. Attribute changes include inherited
      // fonts, theme tokens, no-caret classes and role changes. A moved/removed
      // target or new sibling overlay requires another hit test.
      if (target && target !== cursor && !cursor.contains(target)) {
        observer.observe(target, { attributes: true, childList: true });
        for (const child of target.childNodes)
          if (child.nodeType === Node.TEXT_NODE) observer.observe(child, { characterData: true });
        for (let parent = target.parentElement; parent; parent = parent.parentElement)
          observer.observe(parent, { attributes: true, childList: true });
      }
      observer.observe(document.head, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });

      const editor = target?.closest(EDITOR_TARGET);
      const structuralRole = structuralCursorRole(target, noCaretTargets);
      const forcedEditorCaret = structuralRole === 'text';
      const interactive = structuralRole === 'interactive';
      let text = forcedEditorCaret;
      if (forcedEditorCaret && editor) {
        const style = getComputedStyle(editor);
        cursor.style.setProperty(
          '--custom-cursor-caret-height',
          `${Math.round(Number.parseFloat(style.fontSize) * 1.3)}px`,
        );
      } else if (!interactive && target && !target.closest(noCaretTargets)) {
        const hasText = Array.from(target.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        if (hasText) {
          const style = getComputedStyle(target);
          if (style.userSelect !== 'none') {
            text = true;
            cursor.style.setProperty(
              '--custom-cursor-caret-height',
              `${Math.round(Number.parseFloat(style.fontSize) * 1.3)}px`,
            );
          }
        }
      }
      cursor.classList.toggle('is-interactive', interactive);
      cursor.classList.toggle('is-text', text);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !finePointer.matches) {
        hide();
        return;
      }
      point = {
        x: event.clientX,
        y: event.clientY,
        target: event.target instanceof Element ? event.target : null,
      };
      // The event already carries the current hit target. Keep only its latest
      // coordinates; there is no animation loop when the pointer is stationary.
      hitTest = false;
      schedule();
    };
    const pointerChanged = () => {
      if (!finePointer.matches) hide();
      else invalidate();
    };

    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', invalidate);
    document.addEventListener('scroll', invalidate, true);
    document.addEventListener('focusin', invalidate);
    document.addEventListener('focusout', invalidate);
    document.addEventListener('pointerdown', invalidate);
    document.addEventListener('pointerup', invalidate);
    finePointer.addEventListener('change', pointerChanged);
    document.fonts.addEventListener('loadingdone', invalidate);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', invalidate);
      document.removeEventListener('scroll', invalidate, true);
      document.removeEventListener('focusin', invalidate);
      document.removeEventListener('focusout', invalidate);
      document.removeEventListener('pointerdown', invalidate);
      document.removeEventListener('pointerup', invalidate);
      finePointer.removeEventListener('change', pointerChanged);
      document.fonts.removeEventListener('loadingdone', invalidate);
      hide();
    };
  }, [noCaretTargets, ref]);
}
