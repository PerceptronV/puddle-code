import { afterEach, expect, it, vi } from 'vitest';
import { PtyManager } from '../../../src/pty/pty-manager.js';
import type { LogStore } from '../../../src/logs/log-store.js';
import { screenContention } from '../../helpers/pty/contention.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node-pty', () => ({ default: { spawn } }));
afterEach(() => vi.clearAllMocks());

function manager(capacity?: number) {
  const f = screenContention(capacity);
  const health = vi.fn();
  const ptys = new PtyManager({} as LogStore, undefined, undefined, health, f.allowance);
  const child = { pid: 123, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
  spawn.mockReturnValue(child);
  const start = (current = () => true) =>
    ptys.spawnPrepared(
      'first',
      'agent',
      '/fake/shell',
      [],
      { cwd: '/fake', record: false },
      { cols: 80, rows: 24 },
      current,
    );
  return { ...f, ptys, health, start };
}

it('does not create a native PTY until first-screen geometry and restore have been admitted', async () => {
  const f = manager();
  const baseline = f.allowance.reserve(4 * 1024 * 1024 - 128)!;
  f.ledger.busy = 2;
  try {
    const pending = f.start();
    expect(spawn).not.toHaveBeenCalled();
    await pending;
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cols: 80, rows: 24 });
    expect(await f.ptys.canonicalSnapshot('first', 'agent')).toBe('');
    expect(f.health).not.toHaveBeenCalledWith(true);
  } finally {
    f.ptys.killAll();
    await f.ptys.closeTerminalStates();
    baseline();
  }
  expect(f.allowance.usedBytes).toBe(0);
});

it('definitive host exhaustion refuses the PTY rather than starting with a canonical gap', async () => {
  const f = manager(4 * 1024 * 1024);
  const baseline = f.allowance.reserve(4 * 1024 * 1024)!;
  try {
    await expect(f.start()).rejects.toThrow('capacity exhausted');
    expect(spawn).not.toHaveBeenCalled();
    expect(f.health).not.toHaveBeenCalled();
  } finally {
    await f.ptys.closeTerminalStates();
    baseline();
  }
});

it('releases prepared screens after repeated cancellation or a failed native spawn', async () => {
  const f = manager();
  try {
    for (let index = 0; index < 40; index++) {
      await expect(
        f.ptys.spawnPrepared(
          'first',
          `shell-${index}`,
          '/fake/shell',
          [],
          { cwd: '/fake' },
          { cols: 80, rows: 24 },
          () => false,
        ),
      ).rejects.toThrow('cancelled');
      expect(f.allowance.usedBytes).toBe(0);
    }
    expect(spawn).not.toHaveBeenCalled();
    spawn.mockImplementationOnce(() => {
      throw new Error('native spawn failed');
    });
    await expect(f.start()).rejects.toThrow('native spawn failed');
    expect(f.allowance.usedBytes).toBe(0);
    await f.start();
    expect(f.ptys.liveCount()).toBe(1);
  } finally {
    f.ptys.killAll();
    await f.ptys.closeTerminalStates();
  }
  expect(f.allowance.usedBytes).toBe(0);
});

it.each(['authority', 'shutdown'])(
  'rechecks %s after admission yields and never dispatches a stale PTY',
  async (reason) => {
    const f = manager();
    f.ledger.busy = 1;
    let current = true;
    try {
      const pending = f.start(() => current);
      if (reason === 'authority') current = false;
      else f.ptys.beginShutdown();
      await expect(pending).rejects.toThrow('cancelled');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await f.ptys.closeTerminalStates();
    }
    expect(f.allowance.usedBytes).toBe(0);
  },
);
