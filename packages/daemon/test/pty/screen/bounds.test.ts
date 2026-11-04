import headless, { type ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { ScreenParserQueue } from '../../../src/pty/screen/queue.js';
import { serialiseScreen } from '../../../src/pty/screen/serialise.js';
import { screenActionBytes } from '../../../src/pty/screen/limits.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import { ScreenSnapshotWork } from '../../../src/pty/screen/work.js';

const { Terminal } = headless;
function emulator(cols = 40, rows = 4) {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 20_000 });
  const serialiser = new SerializeAddon();
  terminal.loadAddon(serialiser as unknown as ITerminalAddon);
  return { terminal, serialiser };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it('shares parser byte/action limits across screens and retains cancelled closures until settled', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 1000, count: 3 });
  const failure = vi.fn();
  const first = new ScreenParserQueue(budget, failure);
  const second = new ScreenParserQueue(budget, failure);
  const gate = deferred();
  const skipped = vi.fn(async () => {});
  expect(first.enqueue(200, () => gate.promise)).toBe(true);
  await Promise.resolve();
  expect(first.enqueue(200, skipped)).toBe(true);
  expect(second.enqueue(200, async () => {})).toBe(true);
  expect(first.enqueue(0, skipped)).toBe(false);
  expect(failure).toHaveBeenCalledOnce();
  expect(budget.usedCount).toBe(3);
  await second.settled;
  expect(budget.usedBytes).toBe(400);
  first.close();
  expect(budget.usedBytes).toBe(400);
  gate.resolve();
  await first.settled;
  expect(skipped).not.toHaveBeenCalled();
  expect(budget.usedCount).toBe(0);
  expect(budget.usedBytes).toBe(0);
});

it('bounds UTF-8 plus retained JS strings and releases rejected parser work', async () => {
  expect(screenActionBytes('界😀')).toBe(Buffer.byteLength('界😀') + 6 + 128);
  const budget = new RuntimeBufferBudget({ bytes: 140, count: 4 });
  const failed = vi.fn();
  const queue = new ScreenParserQueue(budget, failed);
  expect(queue.enqueue(screenActionBytes('界😀'), async () => {})).toBe(false);
  expect(budget.usedBytes).toBe(0);
  const other = new ScreenParserQueue(budget, failed);
  expect(
    other.enqueue(128, async () => {
      throw new Error('parse failed');
    }),
  ).toBe(true);
  await other.settled;
  expect(budget.usedCount).toBe(0);
  expect(other.enqueue(1, async () => {})).toBe(false);
});

it('bounds snapshot metadata waiters and transfers reservations without over-release', async () => {
  const work = new ScreenSnapshotWork();
  const first = work.tryAcquire()!;
  const second = work.tryAcquire()!;
  const waiting = Array.from({ length: SCREEN_LIMITS.waitingOperations }, () => work.acquire());
  await expect(work.acquire()).rejects.toThrow(/capacity/);
  first();
  first();
  expect(work.budget.usedCount).toBe(2);
  for (const pending of waiting) (await pending)();
  expect(work.budget.usedCount).toBe(1);
  second();
  second();
  expect(work.budget.usedBytes).toBe(0);
});

it('isolates capture capacity/errors from input and rejects cancelled captures without hanging', async () => {
  const input = new RuntimeBufferBudget({ bytes: 1000, count: 2 });
  const captures = new RuntimeBufferBudget({ bytes: 1000, count: 1 });
  const failed = vi.fn();
  const queue = new ScreenParserQueue(input, failed, captures);
  const gate = deferred();
  queue.enqueue(100, () => gate.promise);
  await Promise.resolve();
  const read = queue.capture(100, () => {
    throw new Error('snapshot too large');
  });
  const rejected = expect(read).rejects.toThrow(/snapshot too large/);
  await expect(queue.capture(100, () => 'excess reader')).rejects.toThrow(/capacity/);
  expect(failed).not.toHaveBeenCalled();
  expect(queue.enqueue(100, async () => {})).toBe(true);
  gate.resolve();
  await rejected;
  await queue.settled;
  expect(input.usedCount).toBe(0);
  expect(captures.usedCount).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  const pending = queue.capture(100, () => 'must not run');
  queue.close();
  await expect(pending).rejects.toThrow(/unavailable/);
  await queue.settled;
  expect(captures.usedCount).toBe(0);
});

it('reduces complete old scrollback lines while preserving viewport, alternate buffer and modes', async () => {
  const source = emulator();
  const restored = emulator();
  try {
    const history = Array.from({ length: 1000 }, (_, row) => `line ${row}`).join('\r\n');
    await new Promise<void>((done) => source.terminal.write(history + '\r\nnormal last', done));
    await new Promise<void>((done) =>
      source.terminal.write(
        '\x1b[?1049h\x1b[H\x1b[38;2;23;45;67m界e\u0301 alternate\x1b[?1003h\x1b[?1006h\x1b[?2004h',
        done,
      ),
    );
    const data = serialiseScreen(source.terminal, source.serialiser, 16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(16 * 1024);
    expect(data).not.toContain('line 0\r');
    await new Promise<void>((done) => restored.terminal.write(data, done));
    expect(restored.terminal.buffer.active.type).toBe('alternate');
    expect(restored.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      '界e\u0301 alternate',
    );
    expect(restored.terminal.modes.mouseTrackingMode).toBe('any');
    expect(restored.terminal.modes.bracketedPasteMode).toBe(true);
    expect(data).toContain('\x1b[?1006h');
    const normal = restored.terminal.buffer.normal;
    expect(
      Array.from({ length: normal.length }, (_, row) =>
        normal.getLine(row)?.translateToString(true),
      ),
    ).toContain('normal last');
  } finally {
    source.terminal.dispose();
    restored.terminal.dispose();
  }
});

it('refuses an oversized visible or combined-character screen before calling the serialiser', async () => {
  const source = emulator();
  try {
    await new Promise<void>((done) => source.terminal.write('e' + '\u0301'.repeat(2000), done));
    const serialize = vi.spyOn(source.serialiser, 'serialize');
    expect(() => serialiseScreen(source.terminal, source.serialiser, 8192)).toThrow(/viewport/);
    expect(serialize).not.toHaveBeenCalled();
  } finally {
    source.terminal.dispose();
  }
});
