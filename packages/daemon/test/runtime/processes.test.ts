import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { RuntimeResponse } from '@puddle/shared';
import type { RuntimeClient } from '../../src/runtime/client.js';
import type { RuntimeConnections } from '../../src/runtime/connections.js';
import { RuntimeProcesses } from '../../src/runtime/processes.js';
import { PortScanner } from '../../src/ports/scanner.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

function fixture() {
  const f = runtimeDatabase();
  const response = {
    t: 'state',
    state: {
      state: 'running',
      binding: { session_id: f.session.id, segment_id: f.binding.runtime_id },
      terminals: [{ pid: process.pid }, { pid: null }],
      agent: { sidecar_pids: [process.pid], hidden_ports: [7439] },
    },
  } as RuntimeResponse;
  const emitter = Object.assign(new EventEmitter(), {
    request: vi.fn(async () => response),
  });
  let connected: RuntimeClient | null = emitter as unknown as RuntimeClient;
  const connections = { get: () => connected } as unknown as RuntimeConnections;
  const processes = new RuntimeProcesses(f.runtimes, connections);
  return {
    ...f,
    emitter,
    processes,
    disconnect() {
      connected = null;
      emitter.emit('disconnected');
    },
    async close() {
      emitter.emit('disconnected');
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('inspects exact live roots, hides sidecar ports and invalidates cached ports on owner loss', async () => {
  const f = fixture();
  try {
    const legacy = vi.fn(() => [process.pid]);
    const scanner = new PortScanner({
      ptys: { pidsFor: legacy },
      external: f.processes,
      lister: async () => [
        { pid: process.pid, port: 7439, command: 'bridge', address: '127.0.0.1' },
        { pid: process.pid, port: 4173, command: 'preview', address: '127.0.0.1' },
      ],
    });
    expect((await scanner.scan(f.session.id)).map((port) => port.port)).toEqual([4173]);
    expect((await scanner.scan(f.session.id)).map((port) => port.port)).toEqual([4173]);
    expect(f.emitter.request).toHaveBeenCalledTimes(1);
    f.disconnect();
    expect(await scanner.scan(f.session.id)).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['native-lifecycle', 'terminal-created', 'exit', 'agent-state'])(
  'invalidates process snapshots as soon as %s arrives, before database reconciliation',
  async (t) => {
    const f = fixture();
    try {
      const snapshot = await f.processes.snapshot(f.session.id);
      expect(snapshot.pids).toEqual([process.pid]);
      expect(snapshot.valid()).toBe(true);
      f.emitter.emit('event', { t });
      expect(snapshot.valid()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it('discards a scan whose owner changes while the process listing is pending', async () => {
  const f = fixture();
  try {
    let finish!: () => void;
    const scanner = new PortScanner({
      ptys: { pidsFor: () => [] },
      external: f.processes,
      lister: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve([{ pid: process.pid, port: 4173, command: 'preview', address: '127.0.0.1' }]);
        }),
    });
    const pending = scanner.scan(f.session.id);
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.disconnect();
    finish();
    expect(await pending).toEqual([]);
  } finally {
    await f.close();
  }
});

it('never inspects ended or unbound historical placements as live processes', async () => {
  const f = fixture();
  try {
    f.emitter.request.mockResolvedValueOnce({
      t: 'state',
      state: { state: 'running', binding: null },
    } as RuntimeResponse);
    expect((await f.processes.snapshot(f.session.id)).pids).toEqual([]);
    f.emitter.request.mockClear();
    f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
    expect(f.processes.hasSession(f.session.id)).toBe(true);
    expect((await f.processes.snapshot(f.session.id)).pids).toEqual([]);
    expect(f.emitter.request).not.toHaveBeenCalled();
    f.runtimes.useLegacyTerminals(f.session.id);
    expect(f.processes.hasSession(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});
