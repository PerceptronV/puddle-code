import headless from '@xterm/headless';
import {
  SCREEN_RETAINED_LIMITS,
  ScreenRetainedBudget,
  type ScreenRetainedLimits,
} from '../../../src/pty/screen/retained/budget.js';
import { XtermRetainedState } from '../../../src/pty/screen/retained/xterm.js';
const { Terminal } = headless;

export function retainedScreen(
  options: Partial<ScreenRetainedLimits> = {},
  budget = new ScreenRetainedBudget({ ...SCREEN_RETAINED_LIMITS, scrollback: 8, ...options }),
  cols = 20,
  rows = 3,
) {
  const lease = budget.admit(cols, rows);
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: lease.scrollback,
    allowProposedApi: true,
  });
  const failures: Error[] = [];
  const guard = new XtermRetainedState(terminal, lease, (error) => failures.push(error));
  return { budget, terminal, guard, failures };
}

export function screenLines(terminal: InstanceType<typeof Terminal>): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)!.translateToString(),
  );
}
