import type { ScreenRetainedLease } from './budget.js';
import type { Core } from './internals.js';
import type { Terminal } from '@xterm/headless';

/** History capacity changes must not behave like a user-requested viewport resize. */
export function setHistoryCapacity(terminal: Terminal, core: Core, scrollback: number): void {
  if (terminal.options.scrollback === scrollback) return;
  const buffers = core._bufferService.buffers;
  const positions = [buffers.normal, buffers.alt].map((buffer) => ({
    buffer,
    x: buffer.x,
    y: buffer.y,
    savedX: buffer.savedX,
    top: buffer.scrollTop,
    bottom: buffer.scrollBottom,
  }));
  try {
    // Reuse xterm's exact trim/marker/array replacement. Its unchanged-size
    // resize also resets margins and clamps a pending-wrap cursor; restore only
    // those viewport fields, keeping its history ybase/ydisp/savedY adjustments.
    terminal.options.scrollback = scrollback;
  } finally {
    for (const position of positions) {
      position.buffer.x = position.x;
      position.buffer.y = position.y;
      position.buffer.savedX = position.savedX;
      position.buffer.scrollTop = position.top;
      position.buffer.scrollBottom = position.bottom;
    }
  }
}

/**
 * The pinned BufferService scroll path covers normal line-feed, wrapping and
 * Puddle's CSI-S fix. It clones the cached blank row without getBlankLine, so
 * admission belongs before scroll itself, not solely in the blank-row factory.
 * Resize/reflow remains separately admitted; insert/erase operations stay
 * inside the already admitted viewport/circular-list capacity.
 */
export function guardGeometryGrowth(
  core: Core,
  lease: ScreenRetainedLease,
  unavailable: () => boolean,
  fail: (message: string) => void,
): void {
  const service = core._bufferService;
  const scroll = service.scroll.bind(service);
  service.scroll = (attributes, isWrapped) => {
    if (unavailable()) return;
    const buffer = service.buffers.active;
    if (buffer === service.buffers.normal && buffer.scrollTop === 0 && buffer.lines.isFull) {
      try {
        // Refused optional history is ordinary bounded rollover, not a gap.
        // Existing capacity still covers every row the original call uses.
        lease.owner.grow(lease);
      } catch {
        fail('Canonical terminal history allocation could not be verified');
        return;
      }
    }
    scroll(attributes, isWrapped);
  };
}
