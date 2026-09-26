import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const terminal = new Terminal({ cols: 80, rows: 24 });
terminal.open(document.getElementById('terminal')!);
const input: string[] = [];
// Match the web terminal's input channel: SGR mouse reports must use onData.
terminal.onData((data) => input.push(data));
Object.assign(window, {
  terminalMouse: {
    input: () => [...input],
    clear: () => {
      input.length = 0;
    },
    write: async (data: string, replay: boolean) => {
      if (replay) terminal.reset();
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      input.length = 0;
    },
    cell: (column: number, row: number) => {
      const rect = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
      return {
        x: rect.x + ((column + 0.5) * rect.width) / terminal.cols,
        y: rect.y + ((row + 0.5) * rect.height) / terminal.rows,
      };
    },
  },
});
