import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LogStore } from '../../src/logs/log-store.js';
import {
  RuntimeBufferBudget,
  type RuntimeByteAllowance,
} from '../../src/runtime/resources/budget.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    writeSync: vi.fn(real.writeSync),
    writeFileSync: vi.fn(real.writeFileSync),
    readSync: vi.fn(real.readSync),
  };
});
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const full = () => Object.assign(new Error('No space left'), { code: 'ENOSPC' });
let home: string;
const stores: LogStore[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  home = fs.mkdtempSync(join(tmpdir(), 'puddle-log-allowance-'));
});
afterEach(() => {
  vi.mocked(fs.writeSync).mockReset().mockImplementation(real.writeSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(real.writeFileSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(real.readSync);
  vi.restoreAllMocks();
  vi.advanceTimersByTime(31_000);
  for (const store of stores.splice(0)) store.closeAll();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});
function fixture(bytes = 1024 * 1024, replay = 128, max = 1024 * 1024) {
  const budget = new RuntimeBufferBudget({ bytes, count: 128 });
  const health = vi.fn();
  const logs = new LogStore(home, replay, max, health, budget);
  stores.push(logs);
  return { budget, health, logs };
}

it('reserves before encoding a large append, preserves UTF-8 across internal boundaries and releases after flush', () => {
  const { logs, budget } = fixture();
  const original = Buffer.allocUnsafeSlow;
  let maximumAllocation = 0;
  const allocation = vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation((bytes) => {
    expect(budget.usedBytes).toBeGreaterThanOrEqual(bytes);
    maximumAllocation = Math.max(maximumAllocation, bytes);
    return original(bytes);
  });
  const data = ('a'.repeat(16 * 1024 - 1) + '🙂漢\ud800Z\udc00').repeat(40);
  logs.append('session', 'agent', data);
  expect(budget.usedBytes).toBe(logs.bufferedBytes());
  expect(maximumAllocation).toBeLessThanOrEqual(256 * 1024);
  logs.flushAll();
  allocation.mockRestore();
  expect(fs.readFileSync(join(home, 'session/agent.log'))).toEqual(Buffer.from(data));
  expect(budget.usedBytes).toBe(0);
  logs.closeAll();
  expect(budget.usedCount).toBe(0);
});

it('refuses before slicing/encoding and never throws into live delivery, then accepts later output', () => {
  const { logs, budget, health } = fixture(100);
  const held = budget.reserve(100)!;
  const allocate = vi.spyOn(Buffer, 'allocUnsafeSlow');
  expect(() => logs.append('session', 'agent', 'x'.repeat(1024 * 1024))).not.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(logs.bufferedBytes()).toBe(0);
  expect(budget.usedBytes).toBe(100);
  expect(health).toHaveBeenCalledWith(true);
  held();
  logs.append('session', 'agent', 'later');
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('later');
  expect(health).toHaveBeenLastCalledWith(false);
  expect(budget.usedBytes).toBe(0);
});

it('keeps original pending credit when replacement admission fails and releases working credit', () => {
  const { logs, budget, health } = fixture(110);
  logs.append('session', 'agent', 'a'.repeat(10));
  // 10 retained + 5*20 encoding + 30 replacement would exceed the shared allowance.
  logs.append('session', 'agent', 'b'.repeat(20));
  expect(health).toHaveBeenCalledWith(true);
  expect(logs.bufferedBytes()).toBe(10);
  expect(budget.usedBytes).toBe(10);
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('a'.repeat(10));
  expect(budget.usedBytes).toBe(0);
});

it('charges old and replacement buffers concurrently rather than borrowing another terminal credit', () => {
  const { logs, budget } = fixture(1000);
  logs.append('session', 'agent', 'a'.repeat(10));
  logs.append('session', 'shell', 's'.repeat(10));
  const original = Buffer.allocUnsafeSlow;
  vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation((bytes) => {
    if (bytes === 13) expect(budget.usedBytes).toBe(20 + 15 + 13);
    return original(bytes);
  });
  logs.append('session', 'agent', 'xyz');
  expect(budget.usedBytes).toBe(23);
  logs.closeAll();
  expect(budget.usedBytes).toBe(0);
});

it('retains full backing credit across a partial write and saves its suffix exactly once', () => {
  const { logs, budget } = fixture();
  logs.append('session', 'agent', 'abcdefgh');
  // This path invokes the buffer overload, not fs.writeSync's string overload.
  vi.mocked(fs.writeSync).mockImplementationOnce(((fd: number, buffer: Buffer, offset: number) =>
    real.writeSync(fd, buffer, offset, 3)) as typeof fs.writeSync);
  vi.mocked(fs.writeSync).mockImplementationOnce(() => {
    throw full();
  });
  logs.flushAll();
  expect(logs.bufferedBytes()).toBe(5);
  expect(budget.usedBytes).toBe(8);
  expect(logs.readTail('session', 'agent')).toBe('abcdefgh');
  expect(budget.usedBytes).toBe(8);
  logs.append('session', 'agent', 'ij');
  expect(budget.usedBytes).toBe(7);
  logs.close('session', 'agent');
  expect(budget.usedBytes).toBe(7);
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('abcdefghij');
  expect(budget.usedBytes).toBe(0);
});

it('retains exact written-prefix evidence if rotation memory is unavailable, then rotates without replay', () => {
  const budget = new RuntimeBufferBudget({ bytes: 1000, count: 128 });
  let refuseRotation = true;
  const allowance: RuntimeByteAllowance = {
    reserve(bytes) {
      return refuseRotation && bytes === 32 ? null : budget.reserve(bytes);
    },
  };
  const health = vi.fn();
  const logs = new LogStore(home, 8, 64, health, allowance);
  stores.push(logs);
  logs.append('session', 'agent', 'x'.repeat(100) + 'END');
  logs.flushAll();
  expect(health).toHaveBeenCalledWith(true);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('x'.repeat(100) + 'END');
  expect(logs.bufferedBytes()).toBe(0);
  expect(budget.usedBytes).toBe(103); // Backing remains retained by the retry marker.
  refuseRotation = false;
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('x'.repeat(29) + 'END');
  expect(budget.usedBytes).toBe(0);
  expect(logs.readTail('session', 'agent')).toBe('xxxxxEND');
  expect(budget.usedBytes).toBe(0);
});

it('releases rotation working bytes on disk failure and keeps the last complete on-disk prefix', () => {
  const { logs, budget } = fixture(1024, 8, 64);
  logs.append('session', 'agent', 'x'.repeat(100));
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    expect(budget.usedBytes).toBe(132);
    throw full();
  });
  logs.flushAll();
  expect(budget.usedBytes).toBe(100);
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('x'.repeat(100));
  vi.advanceTimersByTime(1000);
  expect(budget.usedBytes).toBe(0);
});

it('refuses replay working memory before allocation and recovers without mutating saved bytes', () => {
  const { logs, budget, health } = fixture(100, 16);
  logs.append('session', 'agent', 'saved');
  logs.flushAll();
  const held = budget.reserve(100)!;
  const allocate = vi.spyOn(Buffer, 'allocUnsafeSlow');
  expect(logs.readTail('session', 'agent')).toBe('');
  expect(allocate).not.toHaveBeenCalled();
  expect(health).toHaveBeenCalledWith(true);
  held();
  expect(logs.readTail('session', 'agent')).toBe('saved');
  expect(budget.usedBytes).toBe(0);
});

it('releases encoding credit after allocation failure and contains failing health observers', () => {
  const budget = new RuntimeBufferBudget({ bytes: 100, count: 4 });
  const logs = new LogStore(
    home,
    16,
    64,
    () => {
      throw new Error('observer failed');
    },
    budget,
  );
  stores.push(logs);
  vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementationOnce(() => {
    throw new Error('allocation failed');
  });
  expect(() => logs.append('session', 'agent', 'hello')).not.toThrow();
  expect(budget.usedBytes).toBe(0);
  expect(logs.bufferedBytes()).toBe(0);
});

it('shares admission across stores and recovers after another store flushes its retained data', () => {
  const { logs, budget } = fixture(100);
  const other = new LogStore(join(home, 'other'), 16, 64, undefined, budget);
  stores.push(other);
  logs.append('session', 'agent', 'first');
  const held = budget.reserve(90)!;
  expect(() => other.append('session', 'agent', 'later')).not.toThrow();
  expect(other.bufferedBytes()).toBe(0);
  expect(budget.usedBytes).toBe(95);
  held();
  logs.flushAll();
  other.append('session', 'agent', 'later');
  vi.advanceTimersByTime(1000);
  expect(fs.readFileSync(join(home, 'other/session/agent.log'), 'utf8')).toBe('later');
  expect(budget.usedBytes).toBe(0);
});

it('keeps the original total and per-terminal outage limits with all retained buffers charged', () => {
  const { logs, budget } = fixture(10 * 1024 * 1024);
  vi.mocked(fs.writeSync).mockImplementation(() => {
    throw full();
  });
  logs.append('session', 'agent', 'initial');
  logs.flushAll();
  for (let index = 0; index < 36; index++)
    logs.append(String(index), 'agent', 'x'.repeat(300 * 1024));
  expect(logs.bufferedBytes()).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(budget.usedBytes).toBe(logs.bufferedBytes());
  expect(logs.readTail('35', 'agent')).toBe('x'.repeat(128));
  expect(budget.usedBytes).toBe(logs.bufferedBytes());
});

it('finishes short rotation reads before replacing the file, preserving the exact tail', () => {
  const { logs, budget } = fixture(1024, 8, 64);
  logs.append('session', 'agent', 'x'.repeat(100) + 'END');
  vi.mocked(fs.readSync).mockImplementationOnce(((
    fd: number,
    buffer: Buffer,
    offset: number,
    _length: number,
    position: number,
  ) => real.readSync(fd, buffer, offset, 5, position)) as typeof fs.readSync);
  logs.flushAll();
  expect(fs.readFileSync(join(home, 'session/agent.log'), 'utf8')).toBe('x'.repeat(29) + 'END');
  expect(budget.usedBytes).toBe(0);
});
