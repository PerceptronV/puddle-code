import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import headless, { type Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalScreenStateStore } from '../../../src/pty/terminal-screen-state.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import { SCREEN_LIMITS } from '../../../src/pty/screen/limits.js';
import {
  SCREEN_RETAINED_LIMITS,
  ScreenRetainedBudget,
} from '../../../src/pty/screen/retained/budget.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const writes = vi.fn(real.writeFile);
  return {
    ...real,
    writeFile: writes,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      // Keep slow-disk controls at the shared atomic writer's opened descriptor.
      handle.writeFile = (data, options) => writes(handle, data, options);
      return handle;
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockReset().mockImplementation(real.writeFile);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(parserBytes = SCREEN_LIMITS.parserBytes) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-screen-budget-'));
  const health = vi.fn();
  const parser = new RuntimeBufferBudget({ bytes: parserBytes, count: 64 });
  const transient = new RuntimeBufferBudget({
    bytes: SCREEN_LIMITS.transientBytes,
    count: SCREEN_LIMITS.transientOperations,
  });
  const retained = new ScreenRetainedBudget();
  const store = new TerminalScreenStateStore(home, health, {
    parserBudget: parser,
    transientBudget: transient,
    retainedBudget: retained,
  });
  return {
    home,
    health,
    parser,
    transient,
    retained,
    store,
    file: join(home, 'session', 'agent.terminal.json'),
  };
}

it('retains emulator credit through slow persistence after a canonical input gap', async () => {
  const f = fixture(1024);
  const gate = deferred();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await gate.promise;
    return real.writeFile(...args);
  });
  try {
    f.store.write('session', 'agent', 'last good screen');
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce(), { timeout: 2500 });
    const retained = f.retained.geometryBytes;
    expect(retained).toBeGreaterThan(0);
    f.store.write('session', 'agent', 'x'.repeat(1024));
    await expect(f.store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    await vi.waitFor(() => expect(f.parser.usedCount).toBe(0));
    expect(f.retained.geometryBytes).toBe(retained);
    gate.resolve();
    await vi.waitFor(() => expect(f.retained.geometryBytes).toBe(0));
    expect(f.transient.usedCount).toBe(0);
  } finally {
    gate.resolve();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('uses retained-state guards when restoring a bounded but unsafe saved screen', async () => {
  const f = fixture();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mkdirSync(join(f.home, 'session'), { mode: 0o700 });
  const original = JSON.stringify({ version: 1, cols: 20, rows: 3, data: 'a\x1b[100000000b' });
  writeFileSync(f.file, original, { mode: 0o600 });
  try {
    await expect(f.store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    await vi.waitFor(() => expect(f.retained.geometryBytes).toBe(0));
    expect(readFileSync(f.file, 'utf8')).toBe(original);
    f.store.write('other', 'agent', 'healthy');
    expect(await f.store.snapshot('other', 'agent')).toContain('healthy');
  } finally {
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('keeps initial canonical admission refusal inside the store output and resize boundary', async () => {
  const f = fixture();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let refused: TerminalScreenStateStore | undefined;
  try {
    f.store.write('session', 'agent', 'known good');
    await f.store.closeAll();
    const saved = readFileSync(f.file, 'utf8');
    const budget = new ScreenRetainedBudget({ ...SCREEN_RETAINED_LIMITS, geometryBytes: 128 });
    refused = new TerminalScreenStateStore(f.home, f.health, { retainedBudget: budget });
    expect(() => refused!.resize('session', 'agent', 120, 32)).not.toThrow();
    expect(() => refused!.write('session', 'agent', 'PTY delivery can continue')).not.toThrow();
    await expect(refused.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    expect(f.health).toHaveBeenCalledWith(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(readFileSync(f.file, 'utf8')).toBe(saved);
    expect(budget.geometryBytes).toBe(0);
  } finally {
    await refused?.closeAll();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('keeps parsing during slow disk IO and coalesces newer revisions before shutdown', async () => {
  const f = fixture();
  const gate = deferred();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await gate.promise;
    return real.writeFile(...args);
  });
  try {
    f.store.write('session', 'agent', 'old screen');
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce(), { timeout: 2500 });
    for (let row = 0; row < 50; row++) f.store.write('session', 'agent', `\r\nnew ${row}`);
    const snapshot = await f.store.snapshot('session', 'agent');
    expect(snapshot).toContain('new 49');
    expect(f.parser.usedCount).toBe(0);
    expect(f.transient.usedCount).toBe(1);
    expect(writeFile).toHaveBeenCalledOnce();
    let closed = false;
    const closing = f.store.closeAll();
    expect(f.store.closeAll()).toBe(closing);
    const close = closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.transient.usedCount).toBe(1);
    gate.resolve();
    await close;
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(f.file, 'utf8')).data).toContain('new 49');
    expect(f.transient.usedCount).toBe(0);
    expect(readdirSync(join(f.home, 'session'))).toEqual(['agent.terminal.json']);
  } finally {
    gate.resolve();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('marks only overflowing canonical input unavailable and retains its last good file after release', async () => {
  const f = fixture(1024);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    f.store.write('session', 'agent', 'known good');
    await f.store.release('session', 'agent');
    const good = readFileSync(f.file, 'utf8');
    expect(await f.store.snapshot('session', 'agent')).toContain('known good');
    f.store.write('session', 'agent', 'x'.repeat(1024));
    f.store.write('session', 'agent', 'later bytes must not pretend to repair missing input');
    await expect(f.store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    await f.store.release('session', 'agent');
    await expect(f.store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    expect(f.health).toHaveBeenCalledWith(true);
    expect(warning).toHaveBeenCalledOnce();
    f.store.write('other', 'agent', 'still parsing');
    expect(await f.store.snapshot('other', 'agent')).toContain('still parsing');
    expect(readFileSync(f.file, 'utf8')).toBe(good);
    expect(f.parser.usedCount).toBe(0);
  } finally {
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('does not republish a forgotten screen after a pending atomic write finishes', async () => {
  const f = fixture();
  const gate = deferred();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await gate.promise;
    return real.writeFile(...args);
  });
  try {
    f.store.write('session', 'agent', 'to be removed');
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce(), { timeout: 2500 });
    const forget = f.store.forget('session');
    await Promise.resolve();
    expect(f.transient.usedCount).toBe(1);
    gate.resolve();
    await forget;
    expect(readdirSync(join(f.home, 'session'))).toEqual([]);
    expect(f.transient.usedCount).toBe(0);
    expect(f.parser.usedCount).toBe(0);
  } finally {
    gate.resolve();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('rejects oversized saved files before parsing and never replaces them with an empty screen', async () => {
  const f = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    await real.mkdir(join(f.home, 'session'));
    writeFileSync(f.file, '{');
    truncateSync(f.file, SCREEN_LIMITS.fileBytes + 1);
    await expect(f.store.snapshot('session', 'agent')).rejects.toThrow(/unavailable/);
    expect(f.health).toHaveBeenCalledWith(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
    expect(f.transient.usedCount).toBe(0);
  } finally {
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('limits concurrent serialised writes across terminals, with pending revisions held as metadata', async () => {
  const f = fixture();
  const gate = deferred();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    await gate.promise;
    return real.writeFile(...args);
  });
  try {
    for (const term of ['first', 'second', 'third']) {
      f.store.write('session', term, term);
      await f.store.snapshot('session', term);
    }
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(f.transient.usedCount).toBe(2);
    expect(f.transient.usedBytes).toBe(SCREEN_LIMITS.transientBytes);
    await expect(f.store.snapshot('session', 'third')).rejects.toThrow(/capacity/);
    expect(f.parser.usedCount).toBe(0);
    gate.resolve();
    await f.store.closeAll();
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(f.transient.usedCount).toBe(0);
    expect(readdirSync(join(f.home, 'session')).sort()).toEqual([
      'first.terminal.json',
      'second.terminal.json',
      'third.terminal.json',
    ]);
  } finally {
    gate.resolve();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it('captures at the admitted parser boundary before subsequently queued output', async () => {
  const store = new TerminalScreenStateStore();
  const entered = deferred();
  const gate = deferred();
  const write = headless.Terminal.prototype.write;
  vi.spyOn(headless.Terminal.prototype, 'write').mockImplementation(function (
    this: HeadlessTerminal,
    data,
    callback,
  ) {
    if (data !== 'held output') return write.call(this, data, callback);
    write.call(this, 'before-', () => {
      entered.resolve();
      void gate.promise.then(() => write.call(this, 'boundary', callback));
    });
  });
  try {
    store.write('session', 'agent', 'held output');
    await entered.promise;
    const snapshot = store.snapshot('session', 'agent');
    const preview = store.textTail('session', 'agent');
    store.write('session', 'agent', '\r\nafter boundary');
    gate.resolve();
    expect(await snapshot).toContain('before-boundary');
    expect(await snapshot).not.toContain('after boundary');
    expect(await preview).toBe('before-boundary');
    expect(await store.snapshot('session', 'agent')).toContain('after boundary');
  } finally {
    gate.resolve();
    await store.closeAll();
  }
});

it('waits for an ordered complete parse after a persistence slot becomes available', async () => {
  const f = fixture();
  const diskGate = deferred();
  const parseGate = deferred();
  const entered = deferred();
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let writes = 0;
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    if (++writes <= 2) await diskGate.promise;
    return real.writeFile(...args);
  });
  const write = headless.Terminal.prototype.write;
  vi.spyOn(headless.Terminal.prototype, 'write').mockImplementation(function (
    this: HeadlessTerminal,
    data,
    callback,
  ) {
    if (data !== 'held output') return write.call(this, data, callback);
    write.call(this, 'prefix-', () => {
      entered.resolve();
      void parseGate.promise.then(() => write.call(this, 'suffix', callback));
    });
  });
  try {
    for (const term of ['first', 'second', 'third']) {
      f.store.write('session', term, term + '\r\n');
      await f.store.snapshot('session', term);
    }
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2), { timeout: 2500 });
    f.store.write('session', 'third', 'held output');
    await entered.promise;
    diskGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writeFile).toHaveBeenCalledTimes(2);
    parseGate.resolve();
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(3));
    await f.store.closeAll();
    const saved = JSON.parse(readFileSync(join(f.home, 'session', 'third.terminal.json'), 'utf8'));
    expect(saved.data).toContain('prefix-suffix');
    expect(f.transient.usedCount).toBe(0);
    expect(f.parser.usedCount).toBe(0);
  } finally {
    diskGate.resolve();
    parseGate.resolve();
    await f.store.closeAll();
    rmSync(f.home, { recursive: true, force: true });
  }
});
