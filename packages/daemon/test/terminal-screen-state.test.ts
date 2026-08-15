import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { TerminalScreenStateStore } from '../src/pty/terminal-screen-state.js';

const { Terminal } = headless;
const require = createRequire(import.meta.url);

interface XtermPackageMetadata {
  version: string;
  commit: string;
}

function xtermPackage(name: string): XtermPackageMetadata {
  return JSON.parse(
    readFileSync(require.resolve(`${name}/package.json`), 'utf8'),
  ) as XtermPackageMetadata;
}

async function visibleLines(snapshot: string, cols: number, rows: number): Promise<string[]> {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 20_000 });
  await new Promise<void>((resolve) => terminal.write(snapshot, resolve));
  const lines: string[] = [];
  for (let row = 0; row < terminal.buffer.active.length; row++) {
    lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '');
  }
  terminal.dispose();
  return lines;
}

describe('TerminalScreenStateStore', () => {
  it('keeps the experimental headless/serialiser boundary on one upstream commit', () => {
    const headlessPackage = xtermPackage('@xterm/headless');
    const serialiserPackage = xtermPackage('@xterm/addon-serialize');
    expect(headlessPackage.version).toBe('6.0.0');
    expect(serialiserPackage.version).toBe('0.14.0');
    expect(headlessPackage.commit).toBe(serialiserPackage.commit);
  });

  it('serialises a cursor-addressed screen and restores it after a daemon restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'puddle-terminal-state-'));
    const first = new TerminalScreenStateStore(stateDir);
    first.resize('session-1', 'agent', 40, 12);
    first.write('session-1', 'agent', 'old output that a redraw replaces');
    first.write('session-1', 'agent', '\u001b[2J\u001b[Hle-sdk\u001b[10;1HWorking 56s');

    const snapshot = await first.snapshot('session-1', 'agent');
    expect(snapshot).not.toBeNull();
    expect(await visibleLines(snapshot ?? '', 40, 12)).toEqual(
      expect.arrayContaining(['le-sdk', 'Working 56s']),
    );
    await first.closeAll();

    const file = join(stateDir, 'session-1', 'agent.terminal.json');
    expect(existsSync(file)).toBe(true);
    const restored = new TerminalScreenStateStore(stateDir);
    const restoredSnapshot = await restored.snapshot('session-1', 'agent');
    expect(await visibleLines(restoredSnapshot ?? '', 40, 12)).toEqual(
      expect.arrayContaining(['le-sdk', 'Working 56s']),
    );
    await restored.closeAll();
  });

  it('removes persisted state when a stream is permanently forgotten', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'puddle-terminal-state-'));
    const store = new TerminalScreenStateStore(stateDir);
    store.write('login-1', 'shell-1', 'temporary login');
    await store.closeAll();
    expect(existsSync(join(stateDir, 'login-1', 'shell-1.terminal.json'))).toBe(true);

    const reopened = new TerminalScreenStateStore(stateDir);
    await reopened.forget('login-1');
    expect(existsSync(join(stateDir, 'login-1', 'shell-1.terminal.json'))).toBe(false);
  });
});
