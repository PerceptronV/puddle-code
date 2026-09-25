import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { attachNativeTerminalInput } from '../../src/features/terminal/native-input';
import { attachTerminalTouchScroll } from '../../src/features/terminal/touch-scroll';
import { TerminalKey } from '../../src/features/mobile/TerminalKey';
import { PhoneDiff } from '../../src/features/mobile/PhoneDiff';
import '../../src/features/remote/remote.css';
import '../../src/styles/tokens.css';

const terminal = new Terminal({ cols: 32, rows: 8 });
terminal.open(document.getElementById('terminal')!);
let active = true;
let input: string[] = [];
const native = attachNativeTerminalInput(terminal, () => active);
terminal.onData((data) => {
  native.observe(data);
  input.push(data);
});
attachTerminalTouchScroll(
  terminal,
  () => active,
  () => {},
  () => {},
  (x, y) => native.tap(x, y),
);
const send = (data: string) => {
  terminal.focus();
  terminal.input(data, true);
};
createRoot(document.getElementById('controls')!).render(
  <div className="phone-keys">
    <TerminalKey activate={() => send('\x1b')}>Esc</TerminalKey>
    <TerminalKey activate={() => send('\x1b[D')}>Left</TerminalKey>
    <TerminalKey activate={() => send('\x1b[C')}>Right</TerminalKey>
  </div>,
);
createRoot(document.getElementById('diff')!).render(
  <PhoneDiff
    before={'heading\nold text\ntail\n'}
    after={'heading\nnew text\n<script>window.executed = true</script>\ntail\n'}
  />,
);
Object.assign(window, {
  editing: {
    input: () => input.join(''),
    clear: () => {
      input = [];
    },
    focus: () => terminal.focus(),
    active: (value: boolean) => {
      active = value;
      if (!value) native.reset();
    },
    write: (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve)),
    cell: (column: number, row: number) => {
      const rect = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
      return {
        x: rect.x + ((column + 0.1) * rect.width) / terminal.cols,
        y: rect.y + ((row + 0.5) * rect.height) / terminal.rows,
      };
    },
  },
});
