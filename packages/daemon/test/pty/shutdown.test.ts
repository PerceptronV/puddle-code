import { describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../src/pty/pty-manager.js';
import type { LogStore } from '../../src/logs/log-store.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node-pty', () => ({ default: { spawn } }));

describe('terminal shutdown admission', () => {
  it('keeps existing children until explicitly killed and refuses every later spawn', async () => {
    const child = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
    spawn.mockReturnValue(child);
    const logs = { append: vi.fn(), close: vi.fn() };
    const manager = new PtyManager(logs as unknown as LogStore);
    try {
      manager.spawn('session-1', 'agent', '/fake/agent', [], { cwd: '/fake' });
      manager.beginShutdown();
      manager.beginShutdown();
      expect(manager.liveCount()).toBe(1);
      expect(child.kill).not.toHaveBeenCalled();
      expect(() =>
        manager.spawn('session-2', 'agent', '/fake/agent', [], { cwd: '/fake' }),
      ).toThrow(/shutting down/);
      expect(spawn).toHaveBeenCalledOnce();
      manager.killAll();
      expect(child.kill).toHaveBeenCalledOnce();
      await manager.closeTerminalStates();
      expect(() =>
        manager.spawn('session-3', 'shell-1', '/fake/shell', [], { cwd: '/fake' }),
      ).toThrow(/shutting down/);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await manager.closeTerminalStates();
    }
  });
});
