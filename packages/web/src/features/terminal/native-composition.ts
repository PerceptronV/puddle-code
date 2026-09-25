import type { Terminal } from '@xterm/xterm';

/** Keep uncommitted IME candidates visible without sending them to the PTY. */
export function nativeComposition(terminal: Terminal) {
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
  const preview = document.createElement('span');
  preview.className = 'terminal-native-composition';
  preview.hidden = true;
  Object.assign(preview.style, {
    position: 'absolute',
    zIndex: '4',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-base)',
  });
  screen.append(preview);
  const position = () => {
    if (preview.hidden) return;
    const buffer = terminal.buffer.active;
    const bounds = screen.getBoundingClientRect();
    const left = (Math.min(buffer.cursorX, terminal.cols - 1) * bounds.width) / terminal.cols;
    const height = bounds.height / terminal.rows;
    Object.assign(preview.style, {
      left: `${left}px`,
      top: `${(buffer.baseY + buffer.cursorY - buffer.viewportY) * height}px`,
      maxWidth: `${bounds.width - left}px`,
      lineHeight: `${height}px`,
      fontFamily: terminal.options.fontFamily,
      fontSize: `${terminal.options.fontSize}px`,
    });
  };
  const render = terminal.onRender(position);
  return {
    update(text: string) {
      preview.textContent = text;
      preview.hidden = !text;
      position();
    },
    clear() {
      preview.hidden = true;
      preview.textContent = '';
    },
    dispose() {
      render.dispose();
      preview.remove();
    },
  };
}
