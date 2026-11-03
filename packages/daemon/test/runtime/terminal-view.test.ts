import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeEvent, RuntimeResponse } from '@puddle/shared';
import { RuntimeTerminals } from '../../src/runtime/terminals.js';
import type { RuntimeClient } from '../../src/runtime/client.js';
import type { RuntimeConnections } from '../../src/runtime/connections.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

function fixture() {
  const f = runtimeDatabase();
  const generation = randomUUID();
  f.reconciler.applyPage(f.binding.runtime_id, {
    events: [
      {
        t: 'terminal-created',
        cursor: 1,
        terminal: { term: 'agent', generation, pid: 42, exit_code: null, cols: 80, rows: 24 },
      },
    ],
    through: 1,
    more: false,
    gap: false,
    journal: { cursor: 1, acknowledged: 0, lost_through: 0, persistence_pending: false },
  });
  let snapshot!: (response: RuntimeResponse) => void;
  const pending = new Promise<RuntimeResponse>((resolve) => {
    snapshot = resolve;
  });
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn((request: { t: string; data?: string }) =>
      request.t === 'snapshot' ? pending : Promise.resolve({ t: 'ok', id: randomUUID() }),
    ),
  });
  const connections = Object.assign(new EventEmitter(), { get: () => client });
  const terminals = new RuntimeTerminals(
    f.home,
    f.runtimes,
    connections as unknown as RuntimeConnections,
    f.reconciler.observations,
  );
  connections.emit('connected', f.binding.runtime_id, client as unknown as RuntimeClient);
  let valid = true;
  const send = vi.fn();
  const reconnect = vi.fn();
  const view = terminals.open(f.session.id, 'agent', { valid: () => valid, send, reconnect });
  const output = (cursor: number, data: string) =>
    client.emit('event', {
      t: 'output',
      cursor,
      data,
      term: 'agent',
      generation,
      segment_id: f.binding.runtime_id,
    } satisfies RuntimeEvent);
  const finish = () =>
    snapshot({
      t: 'snapshot',
      id: randomUUID(),
      term: 'agent',
      generation,
      segment_id: f.binding.runtime_id,
      cursor: 5,
      data: 'snapshot-through-five',
    });
  return {
    ...f,
    generation,
    client,
    connections,
    view,
    send,
    reconnect,
    output,
    finish,
    revoke: () => {
      valid = false;
    },
    async close() {
      view.dispose();
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('delivers snapshot plus later output exactly once and resizes only after replay', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.output(3, 'already-in-snapshot');
    f.output(6, 'later-output');
    f.finish();
    await start;
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls.map(([m]) => ({ t: m.t, data: m.data }))).toEqual([
      { t: 'replay', data: 'snapshot-through-five' },
      { t: 'output', data: 'later-output' },
    ]);
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual([
      'snapshot',
      'resize',
    ]);
    expect(f.client.request.mock.invocationCallOrder[1]).toBeGreaterThan(
      f.send.mock.invocationCallOrder[0]!,
    );
    await f.view.input('one command');
    expect(f.client.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        t: 'input',
        placement: { session_id: f.session.id, segment_id: f.binding.runtime_id },
        generation: f.generation,
      }),
    );
  } finally {
    await f.close();
  }
});

it('rechecks viewer authority after snapshot work and before mutations', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.revoke();
    f.finish();
    await start;
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.view.input('must not run')).rejects.toThrow(/unavailable/);
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual(['snapshot']);
  } finally {
    await f.close();
  }
});

it('invalidates a pending attach on a native switch without sending the stale snapshot or retrying input', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.client.emit('event', {
      t: 'native-lifecycle',
      cursor: 6,
      segment: { id: randomUUID(), start_cursor: 6, agent_session_ref: 'new' },
      previous_segment_id: f.binding.runtime_id,
      lifecycle: { event: 'session_start', agent_session_ref: 'new', cwd: f.home, source: 'clear' },
    } satisfies RuntimeEvent);
    f.finish();
    await start;
    expect(f.reconnect).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.view.input('must not run')).rejects.toThrow(/unavailable/);
    expect(f.client.request).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('bounds output held behind a snapshot and requests a fresh attachment on overflow or disconnect', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.output(6, 'x'.repeat(2 * 1024 * 1024 + 1));
    f.finish();
    await start;
    expect(f.reconnect).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
  const g = fixture();
  try {
    const start = g.view.start(100, 30);
    g.finish();
    await start;
    g.connections.emit('disconnected', g.binding.runtime_id);
    await expect(g.view.input('uncertain command')).rejects.toThrow(/unavailable/);
    expect(g.reconnect).toHaveBeenCalledTimes(1);
    expect(g.client.request.mock.calls.map(([request]) => request.t)).toEqual([
      'snapshot',
      'resize',
    ]);
  } finally {
    await g.close();
  }
});

it('preserves large Unicode paste ordering and abandons queued input after an uncertain chunk', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.finish();
    await start;
    const paste = 'a'.repeat(65535) + '🌊'.repeat(20000);
    await Promise.all([f.view.input(paste), f.view.input('after-paste')]);
    const inputs = f.client.request.mock.calls
      .map(([request]) => request)
      .filter((request) => request.t === 'input');
    expect(inputs.map((request) => request.data).join('')).toBe(paste + 'after-paste');
    expect(inputs.every((request) => Buffer.byteLength(request.data!) <= 65536)).toBe(true);
    let fail!: (error: Error) => void;
    const uncertain = new Promise<RuntimeResponse>((_, reject) => {
      fail = reject;
    });
    f.client.request.mockImplementationOnce(() => uncertain);
    const first = f.view.input(paste);
    const second = f.view.input('must-not-run');
    const outcomes = Promise.allSettled([first, second]);
    await Promise.resolve();
    fail(new Error('Lost admission response'));
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    const later = f.client.request.mock.calls.slice(-1)[0]![0];
    expect(later.data).toBe(paste.slice(0, 65535));
    expect(f.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('delivers an exit during snapshot capture without attempting a later resize', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.client.emit('event', {
      t: 'exit',
      cursor: 6,
      term: 'agent',
      generation: f.generation,
      exit_code: 7,
    } satisfies RuntimeEvent);
    f.finish();
    await start;
    expect(f.send.mock.calls.map(([message]) => message.t)).toEqual(['replay', 'exit']);
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual(['snapshot']);
    await expect(f.view.input('after exit')).rejects.toThrow(/unavailable/);
  } finally {
    await f.close();
  }
});
