import { useRef } from 'react';
import { GripHorizontal } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import { setRippleBoundary } from './preferences';
import { rippleView } from './view';

/** A row-based bottom anchor survives PTY resizing and font-size changes. */
export function RippleBoundary({
  terminal,
  stream,
  rows,
  inputRows,
}: {
  terminal: Terminal;
  stream: string;
  rows: number;
  inputRows: number | null;
}) {
  const drag = useRef<{ y: number; rows: number; cellHeight: number } | null>(null);
  const move = (value: number) =>
    setRippleBoundary(stream, Math.max(1, Math.min(terminal.rows - 3, value)), inputRows);
  return (
    <div
      role="separator"
      aria-label="Native CLI boundary"
      aria-orientation="horizontal"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, terminal.rows - 3)}
      aria-valuenow={rows}
      aria-valuetext={`${rows} native CLI rows`}
      tabIndex={0}
      className="ripple-boundary"
      title="Drag to expose native CLI rows. Double-click to restore automatic placement."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, rows, cellHeight: rippleView(terminal).cellHeight };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          move(
            drag.current.rows +
              Math.round((drag.current.y - event.clientY) / drag.current.cellHeight),
          );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => setRippleBoundary(stream, null)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(rows + (event.key === 'ArrowUp' ? 1 : -1));
        } else if (event.key === 'Home') {
          event.preventDefault();
          setRippleBoundary(stream, null);
        }
      }}
    >
      <GripHorizontal className="size-4" />
    </div>
  );
}
