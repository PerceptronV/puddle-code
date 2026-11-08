import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import DOMPurify from 'dompurify';
import type { RippleInputSnapshot } from './input';
import { relayRippleCell, rippleAnchorIsCurrent } from './source-map';
import { attachRippleTouchScroll } from './touch-scroll';
import { relayRippleWheel } from './view';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** A projection of native cells, not a second editor. The original xterm textarea
 * retains focus, key encoding, clipboard listeners, IME and mobile input handling. */
export function RippleInput({
  terminal,
  snapshot,
}: {
  terminal: Terminal;
  snapshot: RippleInputSnapshot;
}) {
  const root = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const [focused, setFocused] = useState(document.activeElement === terminal.textarea);
  const [composition, setComposition] = useState('');
  const html = useMemo(
    () => ({
      __html: DOMPurify.sanitize(
        snapshot.rows
          .map(
            (row) =>
              `<div data-ripple-input-row="${row.row}" class="ripple-input-row">` +
              row.cells
                .map(
                  (cell) =>
                    `<span data-ripple-col="${cell.col}" style="width:${(100 * cell.width) / snapshot.cols}%;${cell.css}">${escape(cell.text)}</span>`,
                )
                .join('') +
              '</div>',
          )
          .join(''),
      ),
    }),
    [snapshot],
  );

  useLayoutEffect(() => {
    const element = root.current;
    const textarea = terminal.textarea;
    if (!element || !textarea) return;
    const focus = () => setFocused(true);
    const blur = () => {
      setFocused(false);
      setComposition('');
    };
    const composing = (event: CompositionEvent) => setComposition(event.data);
    const ended = () => setComposition('');
    textarea.addEventListener('focus', focus);
    textarea.addEventListener('blur', blur);
    textarea.addEventListener('compositionupdate', composing);
    textarea.addEventListener('compositionend', ended);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || !event.deltaY) return;
      event.preventDefault();
      relayRippleWheel(terminal, event);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    const detachTouch = attachRippleTouchScroll(element, terminal);
    return () => {
      textarea.removeEventListener('focus', focus);
      textarea.removeEventListener('blur', blur);
      textarea.removeEventListener('compositionupdate', composing);
      textarea.removeEventListener('compositionend', ended);
      element.removeEventListener('wheel', wheel);
      detachTouch();
    };
  }, [terminal]);

  useLayoutEffect(() => {
    const textarea = terminal.textarea;
    const helper = textarea?.offsetParent as HTMLElement | null;
    const element = root.current;
    if (!textarea || !helper || !element) return;
    const position = () => {
      const box = caret.current?.getBoundingClientRect();
      if (!box) return;
      const origin = helper.getBoundingClientRect();
      // Override only coordinates while covered. xterm can continue updating its
      // own inline styles; removing the class restores those live native values.
      textarea.style.setProperty('--ripple-input-left', `${box.left - origin.left}px`);
      textarea.style.setProperty('--ripple-input-top', `${box.top - origin.top}px`);
      textarea.style.setProperty('--ripple-input-height', `${snapshot.cellHeight}px`);
      textarea.classList.add('ripple-input-target');
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      textarea.classList.remove('ripple-input-target');
      for (const property of ['left', 'top', 'height'])
        textarea.style.removeProperty(`--ripple-input-${property}`);
    };
  }, [terminal, snapshot]);

  return (
    <div
      ref={root}
      className="ripple-input"
      role="group"
      aria-label="Live terminal input"
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) terminal.focus();
      }}
      style={{
        fontFamily: snapshot.fontFamily,
        fontSize: snapshot.fontSize,
        lineHeight: `${snapshot.cellHeight}px`,
      }}
      onPointerDown={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY, dragged: false };
      }}
      onPointerMove={(event) => {
        if (
          pointer.current &&
          Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4
        )
          pointer.current.dragged = true;
      }}
      onClick={(event) => {
        if (pointer.current?.dragged || !window.getSelection()?.isCollapsed) return;
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-ripple-col]');
        const row = snapshot.rows.find(
          (row) => row.row === Number(target?.parentElement?.dataset.rippleInputRow),
        );
        if (!target || !row) return;
        const anchor = {
          row: row.row,
          col: Number(target.dataset.rippleCol),
          line: row.text,
          cols: snapshot.cols,
          viewport: snapshot.viewport,
          bufferType: snapshot.bufferType,
        };
        if (!rippleAnchorIsCurrent(terminal, anchor)) return;
        relayRippleCell(terminal, anchor, event.nativeEvent);
        // A CLI without mouse reporting still accepts typing at its own caret.
        terminal.focus();
      }}
    >
      <div dangerouslySetInnerHTML={html} />
      <span
        ref={caret}
        className="ripple-input-caret"
        data-focused={focused}
        data-visible={snapshot.cursor.visible}
        aria-hidden="true"
        style={{
          left: `${(snapshot.cursor.col * 100) / snapshot.cols}%`,
          top: (snapshot.cursor.row - snapshot.first) * snapshot.cellHeight,
          height: snapshot.cellHeight,
        }}
      >
        {composition && <span className="ripple-input-composition">{composition}</span>}
      </span>
    </div>
  );
}
