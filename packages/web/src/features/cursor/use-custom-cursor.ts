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

    const hide = () => {
      cursor.style.opacity = '0';
    };

    const move = (event: PointerEvent) => {
      // Touch devices have no persistent pointer to replace. Re-check the
      // query so attaching or removing a pointing device works without reload.
      if (event.pointerType === 'touch' || !finePointer.matches) {
        hide();
        return;
      }
      cursor.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) translate(-50%, -50%)`;
      const target = event.target instanceof Element ? event.target : null;
      // An embedded document owns its own cursor and does not keep sending
      // pointer movement to this document, so do not strand the custom cursor.
      if (target instanceof HTMLIFrameElement) {
        hide();
        return;
      }

      cursor.style.opacity = '1';
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

    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('blur', hide);
    };
  }, [noCaretTargets, ref]);
}
