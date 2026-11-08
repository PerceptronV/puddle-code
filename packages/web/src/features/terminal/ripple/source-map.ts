import type { Terminal } from '@xterm/xterm';

export interface RippleSourceRow {
  row: number;
  start: number;
  columns: number[];
  text: string;
}
export interface RippleSourceMap {
  cols: number;
  viewport: number;
  bufferType: string;
  rows: RippleSourceRow[];
}
export interface RippleCellAnchor {
  row: number;
  col: number;
  line: string;
  cols: number;
  viewport: number;
  bufferType: string;
}

/** UTF-16 offsets use the native link mapper's wide/combining-cell positions. */
export function rippleCellAtOffset(map: RippleSourceMap, offset: number): RippleCellAnchor | null {
  const row = map.rows.find(
    (row) => offset >= row.start && offset < row.start + row.columns.length,
  );
  const col = row?.columns[offset - row.start];
  return row && col !== undefined
    ? {
        row: row.row,
        col,
        line: row.text,
        cols: map.cols,
        viewport: map.viewport,
        bufferType: map.bufferType,
      }
    : null;
}

/** Match actual DOM text leaves in their bounded source run, never interpolate a
 * prose pixel across terminal rows. Parser-generated text has no click target. */
function offsetInSource(
  span: HTMLElement,
  node: Text,
  offset: number,
  source: string,
): number | null {
  const start = Number(span.dataset.rippleStart);
  const end = Number(span.dataset.rippleEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length)
    return null;
  const raw = source.slice(start, end);
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let at = 0;
  let leaf;
  while ((leaf = walker.nextNode())) {
    const text = leaf.textContent ?? '';
    const found = raw.indexOf(text, at);
    if (found < 0) return null;
    if (leaf === node) return start + found + offset;
    at = found + text.length;
  }
  return null;
}

/** Browser hit testing already includes proportional fonts, wraps and zoom. */
export function rippleOffsetAtPoint(
  root: HTMLElement,
  source: string,
  x: number,
  y: number,
): number | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y);
  const range = caret ? null : doc.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE || offset === undefined || !root.contains(node))
    return null;
  const span = node.parentElement?.closest<HTMLElement>('[data-ripple-start]');
  if (!span || !root.contains(span) || span.closest('.katex,[data-ripple-rich]')) return null;
  const text = node as Text;
  // Carets identify either side of a glyph. Require a real glyph rectangle so
  // clicks in paragraph margins cannot land on the nearest unrelated control.
  for (let index of [offset, offset - 1]) {
    if (index < 0 || index >= text.length) continue;
    if (/[\uDC00-\uDFFF]/.test(text.data[index]!) && index > 0) index--;
    const glyph = doc.createRange();
    glyph.setStart(text, index);
    glyph.setEnd(
      text,
      Math.min(text.length, index + (text.data.codePointAt(index)! > 0xffff ? 2 : 1)),
    );
    if (
      ![...glyph.getClientRects()].some(
        (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top && y <= r.bottom,
      )
    )
      continue;
    return offsetInSource(span, text, index, source);
  }
  return null;
}

/** Reject cells from a previous frame, viewport or terminal size. */
export function rippleAnchorIsCurrent(terminal: Terminal, anchor: RippleCellAnchor): boolean {
  const buffer = terminal.buffer.active;
  return (
    terminal.cols === anchor.cols &&
    buffer.type === anchor.bufferType &&
    buffer.viewportY === anchor.viewport &&
    buffer.getLine(anchor.row)?.translateToString(true) === anchor.line
  );
}

/** Reuse xterm's negotiated mouse encoder, with current-screen validation. */
export function relayRippleCell(
  terminal: Terminal,
  anchor: RippleCellAnchor,
  modifiers: MouseEventInit = {},
): boolean {
  if (terminal.modes.mouseTrackingMode === 'none' || !rippleAnchorIsCurrent(terminal, anchor))
    return false;
  const buffer = terminal.buffer.active;
  const screen = terminal.element?.querySelector('.xterm-screen');
  if (!screen) return false;
  const bounds = screen.getBoundingClientRect();
  const clientX = bounds.left + ((anchor.col + 0.5) * bounds.width) / terminal.cols;
  const clientY =
    bounds.top + ((anchor.row - buffer.viewportY + 0.5) * bounds.height) / terminal.rows;
  if (clientY < bounds.top || clientY >= bounds.bottom) return false;
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
    shiftKey: modifiers.shiftKey,
    ctrlKey: modifiers.ctrlKey,
    altKey: modifiers.altKey,
    metaKey: modifiers.metaKey,
  };
  screen.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
  screen.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  return true;
}
