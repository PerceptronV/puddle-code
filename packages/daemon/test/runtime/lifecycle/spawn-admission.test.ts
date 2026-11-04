import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeCommand, RuntimeTerminal } from '@puddle/shared';
import { RuntimeHost } from '../../../src/runtime/host.js';
import type { PtyManager } from '../../../src/pty/pty-manager.js';

it('fences competing same-term launches while an old controller admission waits and rolls back', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispatched = vi.fn();
  const prepared = vi.fn(async (...args: Parameters<PtyManager['spawnPrepared']>) => {
    await waiting;
    if (!args[6]()) throw new Error('Terminal launch was cancelled');
    dispatched();
  });
  const command: RuntimeCommand = {
    file: '/fake/shell',
    args: [],
    cwd: '/fake',
    env: {},
    cols: 80,
    rows: 24,
  };
  const previous: RuntimeTerminal = {
    term: 'shell-1',
    generation: randomUUID(),
    pid: null,
    exit_code: 0,
    cols: 80,
    rows: 24,
  };
  // Exercise the real host dispatch boundary without its unrelated filesystem,
  // process claims or a native PTY; the existing host suite covers those together.
  const host = Object.assign(
    Object.create(RuntimeHost.prototype) as {
      spawn(term: string, command: RuntimeCommand, authorised: () => boolean): Promise<void>;
      terminals: Map<string, RuntimeTerminal>;
    },
    {
      terminals: new Map([['shell-1', previous]]),
      pendingSpawns: new Set<string>(),
      stopPromise: null,
      ptys: { spawnPrepared: prepared, pidFor: () => 123 },
      launch: { identity: { runtime_id: randomUUID() }, environment: {} },
      observations: { environment: () => ({}) },
      event: vi.fn(),
      eventCursor: 0,
    },
  );
  let oldController = true;
  const old = host.spawn('shell-1', command, () => oldController).catch((error) => error as Error);
  oldController = false;
  await expect(host.spawn('shell-1', command, () => true)).rejects.toThrow('already pending');
  expect(prepared).toHaveBeenCalledOnce();
  finish();
  expect(await old).toMatchObject({ message: expect.stringContaining('cancelled') });
  expect(host.terminals.get('shell-1')).toBe(previous);
  expect(dispatched).not.toHaveBeenCalled();
  await host.spawn('shell-1', command, () => true);
  expect(dispatched).toHaveBeenCalledOnce();
  expect(host.terminals.get('shell-1')?.pid).toBe(123);
  expect(host.terminals.get('shell-1')?.generation).not.toBe(previous.generation);
});
