import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type Dir,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalLogCompactor } from '../../../src/logs/retention/compactor.js';
import { LogRetention } from '../../../src/logs/retention.js';
import {
  LOG_RETENTION_LIMITS,
  type LogRetentionOptions,
} from '../../../src/logs/retention/types.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, opendir: vi.fn(real.opendir), open: vi.fn(real.open) };
});
const now = Date.now();
let home: string;
let compactor: TerminalLogCompactor;
let opened: Dir[];
beforeEach(async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockReset().mockImplementation(real.open);
  vi.mocked(fs.opendir)
    .mockReset()
    .mockImplementation(async (...args) => {
      const directory = await real.opendir(...args);
      opened.push(directory);
      vi.spyOn(directory, 'read');
      return directory;
    });
  opened = [];
  home = mkdtempSync(join(tmpdir(), 'puddle-retention-slices-'));
  compactor = new TerminalLogCompactor();
});
afterEach(async () => {
  await compactor.close();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
function log(stream: string, name: string, data = 'retained bytes\n'.repeat(300)): string {
  mkdirSync(join(home, stream), { recursive: true });
  const file = join(home, stream, `${name}.log`);
  writeFileSync(file, data);
  const old = new Date(now - 4 * 24 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  return file;
}
function options(extra: Partial<LogRetentionOptions> = {}): LogRetentionOptions {
  return { logsDir: home, retentionDays: 3, replayBytes: 1024, isBusy: () => false, now, ...extra };
}
const reads = () => opened.reduce((total, dir) => total + vi.mocked(dir.read).mock.calls.length, 0);

it('resumes bounded traversal without repeatedly scanning the first directories or files', async () => {
  const files = Array.from({ length: 13 }, (_, index) =>
    log(`stream-${index % 3}`, `term-${index}`),
  );
  for (let index = 0; index < 10; index++) writeFileSync(join(home, `diagnostic-${index}`), 'keep');
  const tails = files.map((file) => readFileSync(file).subarray(-1024));
  let compacted = 0;
  let complete = false;
  for (let pass = 0; pass < 40 && !complete; pass++) {
    const before = reads();
    const result = await compactor.sweep(
      options({ limits: { entries: 4, files: 2, copyBytes: 2048 } }),
    );
    expect(reads() - before).toBeLessThanOrEqual(4);
    expect(result.compacted).toBeLessThanOrEqual(2);
    compacted += result.compacted;
    complete = result.complete;
    if (pass === 1) {
      const paused = await compactor.sweep(options({ stopped: () => true }));
      expect(paused.complete).toBe(false);
    }
  }
  expect(complete).toBe(true);
  expect(compacted).toBe(files.length);
  files.forEach((file, index) => expect(readFileSync(file)).toEqual(tails[index]));
  expect(opened).toHaveLength(4); // One root and one handle per stream, never rescanned.
  for (const dir of opened)
    await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
});

it('enforces production ceilings and honours a smaller aggregate copy allowance', async () => {
  for (let index = 0; index < 12; index++) log('stream', `term-${index}`);
  const result = await compactor.sweep(
    options({ limits: { entries: 10000, files: 10000, copyBytes: 10000000, milliseconds: 10000 } }),
  );
  expect(result.compacted).toBe(LOG_RETENTION_LIMITS.files);
  expect(result.complete).toBe(false);
  expect((await compactor.sweep(options({ limits: { copyBytes: 1024 } }))).compacted).toBe(1);
});

it('never shortens a configured replay window to fit the maintenance copy budget', async () => {
  const file = log('stream', 'agent', 'x'.repeat(LOG_RETENTION_LIMITS.copyBytes + 4096));
  const before = statSync(file).size;
  const result = await compactor.sweep(
    options({ replayBytes: LOG_RETENTION_LIMITS.copyBytes + 1024 }),
  );
  expect(result).toMatchObject({ compacted: 0, skipped: 1, complete: true });
  expect(statSync(file).size).toBe(before);
  expect(fs.open).not.toHaveBeenCalled();
});

it('abandons a copy after its cooperative deadline and resumes the same candidate later', async () => {
  const file = log('stream', 'agent');
  const before = readFileSync(file);
  let clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let stalled = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    if (!stalled && String(args[0]).includes('.retention-')) {
      stalled = true;
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        clock += 2000;
        await sync();
      });
    }
    return handle;
  });
  const first = await compactor.sweep(options());
  expect(first).toMatchObject({ compacted: 0, complete: false });
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(join(home, 'stream'))).toEqual(['agent.log']);
  expect((await compactor.sweep(options())).compacted).toBe(1);
  expect(readFileSync(file)).toEqual(before.subarray(-1024));
});

it('skips a repeatedly interrupted copy intact so later files and the traversal can finish', async () => {
  const files = [log('stream', 'first'), log('stream', 'second')];
  const originals = new Map(files.map((file) => [file, readFileSync(file)]));
  let clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let slow: string | undefined;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    const path = String(args[0]);
    if (path.includes('.retention-')) {
      const file = path.slice(0, path.indexOf('.retention-'));
      slow ??= file;
      if (file === slow) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          clock += 2000;
          await sync();
        });
      }
    }
    return handle;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await compactor.sweep(options())).toMatchObject({
      compacted: 0,
      skipped: attempt === 2 ? 1 : 0,
      complete: false,
    });
  }
  expect(slow).toBeDefined();
  expect(readFileSync(slow!)).toEqual(originals.get(slow!));
  expect(await compactor.sweep(options())).toMatchObject({ compacted: 1, complete: true });
  const other = files.find((file) => file !== slow)!;
  expect(readFileSync(other)).toEqual(originals.get(other)!.subarray(-1024));
  expect(readFileSync(slow!)).toEqual(originals.get(slow!));
  expect(readdirSync(join(home, 'stream')).sort()).toEqual(['first.log', 'second.log']);
});

it('refuses a stale directory cursor before touching a replacement path', async () => {
  log('stream', 'first');
  log('stream', 'second');
  expect((await compactor.sweep(options({ limits: { files: 1 } }))).complete).toBe(false);
  renameSync(join(home, 'stream'), join(home, 'old-stream'));
  const replacement = log('stream', 'replacement');
  const before = readFileSync(replacement);
  expect(await compactor.sweep(options())).toMatchObject({ compacted: 0, complete: false });
  expect(readFileSync(replacement)).toEqual(before);
  for (const dir of opened)
    await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
});

it('closes stale cursors when their root becomes a symlink and never traverses the target', async () => {
  log('stream', 'first');
  log('stream', 'second');
  const path = join(home, 'stream');
  await compactor.sweep(options({ logsDir: path, limits: { entries: 1 } }));
  // Use a root with directory children so its cursor remains open between slices.
  await compactor.sweep(options({ limits: { entries: 1 } }));
  const moved = `${home}-moved`;
  renameSync(home, moved);
  symlinkSync(moved, home);
  try {
    expect(await compactor.sweep(options())).toMatchObject({ compacted: 0, complete: false });
    expect(await compactor.sweep(options())).toMatchObject({ compacted: 0, complete: true });
  } finally {
    rmSync(home);
    renameSync(moved, home);
  }
});

it('drains close without publishing a pending copy and closes both traversal handles', async () => {
  const file = log('stream', 'agent');
  const before = readFileSync(file);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let copying = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await real.open(...args);
    if (String(args[0]).includes('.retention-')) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        copying = true;
        await gate;
        await sync();
      });
    }
    return handle;
  });
  const sweep = compactor.sweep(options());
  try {
    await vi.waitFor(() => expect(copying).toBe(true));
    const close = compactor.close();
    release();
    await close;
    expect((await sweep).compacted).toBe(0);
    expect(readFileSync(file)).toEqual(before);
    for (const dir of opened)
      await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    expect(await compactor.sweep(options())).toMatchObject({ complete: true, compacted: 0 });
  } finally {
    release();
    await sweep;
  }
});

it('continues incomplete legacy upkeep through its single existing timer and stops on disposal', async () => {
  vi.useFakeTimers();
  const sweep = vi
    .spyOn(TerminalLogCompactor.prototype, 'sweep')
    .mockResolvedValueOnce({
      compacted: 8,
      reclaimedBytes: 1000,
      skipped: 0,
      failed: 0,
      complete: false,
    })
    .mockResolvedValue({
      compacted: 1,
      reclaimedBytes: 100,
      skipped: 0,
      failed: 0,
      complete: true,
    });
  const retention = new LogRetention(() => options());
  try {
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await retention.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally {
    await retention.dispose();
    vi.useRealTimers();
  }
});
