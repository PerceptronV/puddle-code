/** A native DOM range with held-drag extension; quick drags keep native file scrolling. */
export function attachFileTouchSelection(source: HTMLElement, changed: (text: string) => void) {
  const scroller = source.parentElement!;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let gesture: {
    id: number;
    x: number;
    y: number;
    anchor?: { start: number; end: number };
  } | null = null;
  let frame = 0;
  let pointer: { x: number; y: number } | null = null;
  let lastScroll = 0;
  const text = source.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return () => {};

  const offsetAt = (x: number, y: number) => {
    const bounds = scroller.getBoundingClientRect();
    const cx = Math.max(bounds.left + 1, Math.min(bounds.right - 1, x));
    const cy = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y));
    const caret = document.caretPositionFromPoint?.(cx, cy);
    if (caret?.offsetNode === text) return caret.offset;
    // Safari exposes the older Range API for the same native text hit testing.
    const range = document.caretRangeFromPoint?.(cx, cy);
    return range?.startContainer === text ? range.startOffset : null;
  };
  const select = (start: number, end: number) => {
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    changed(selection?.toString() ?? '');
  };
  const extend = () => {
    if (!gesture?.anchor || !pointer) return;
    const offset = offsetAt(pointer.x, pointer.y);
    if (offset !== null)
      select(Math.min(gesture.anchor.start, offset), Math.max(gesture.anchor.end, offset));
  };
  const scroll = (now: number) => {
    frame = 0;
    if (!pointer) return;
    const bounds = scroller.getBoundingClientRect();
    const dy = pointer.y < bounds.top ? -1 : pointer.y >= bounds.bottom ? 1 : 0;
    const dx = pointer.x < bounds.left ? -1 : pointer.x >= bounds.right ? 1 : 0;
    if ((dy || dx) && now - lastScroll >= 50) {
      lastScroll = now;
      const line = parseFloat(getComputedStyle(source).lineHeight);
      scroller.scrollBy(dx * line, dy * line);
      extend();
    }
    frame = requestAnimationFrame(scroll);
  };
  const reset = () => {
    clearTimeout(hold);
    cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
    gesture = null;
  };
  const start = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    hold = setTimeout(() => {
      if (!gesture) return;
      const offset = offsetAt(gesture.x, gesture.y);
      if (offset === null) return;
      const content = text.textContent ?? '';
      let start = offset;
      let end = offset;
      while (start > 0 && /\S/u.test(content[start - 1]!)) start--;
      while (end < content.length && /\S/u.test(content[end]!)) end++;
      gesture.anchor = { start, end };
      select(start, end);
    }, 450);
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch?.identifier !== gesture.id) {
      reset();
      return;
    }
    if (gesture.anchor) {
      event.preventDefault();
      pointer = { x: touch.clientX, y: touch.clientY };
      extend();
      if (!frame) frame = requestAnimationFrame(scroll);
    } else if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) >= 8) reset();
  };
  const end = (event: TouchEvent) => {
    if (gesture?.anchor) event.preventDefault();
    reset();
  };
  const contextMenu = (event: Event) => {
    if (!gesture) return;
    event.preventDefault();
  };
  const selectionChanged = () => {
    const selection = window.getSelection();
    changed(
      selection?.anchorNode === text && selection.focusNode === text ? selection.toString() : '',
    );
  };
  source.addEventListener('touchstart', start, { passive: true });
  source.addEventListener('touchmove', move, { passive: false });
  source.addEventListener('touchend', end, { passive: false });
  source.addEventListener('touchcancel', reset);
  source.addEventListener('contextmenu', contextMenu);
  document.addEventListener('selectionchange', selectionChanged);
  return () => {
    reset();
    source.removeEventListener('touchstart', start);
    source.removeEventListener('touchmove', move);
    source.removeEventListener('touchend', end);
    source.removeEventListener('touchcancel', reset);
    source.removeEventListener('contextmenu', contextMenu);
    document.removeEventListener('selectionchange', selectionChanged);
  };
}
