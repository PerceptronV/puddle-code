import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeEvent, RuntimeResponse } from '@puddle/shared';
import { RuntimeTerminalView } from '../../../src/runtime/controller/terminals.js';
import { terminalViewFixture as fixture } from '../../helpers/runtime/terminal-view.js';

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

it('keeps a confirmed exit readable across owner shutdown without reconnecting other panes', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.finish();
    await start;
    f.output(6, 'last output');
    f.client.emit('event', {
      t: 'exit',
      cursor: 7,
      term: 'agent',
      generation: f.generation,
      exit_code: 0,
    } satisfies RuntimeEvent);
    f.connections.emit('disconnected', f.binding.runtime_id);
    expect(f.send.mock.calls.map(([message]) => message.t)).toEqual(['replay', 'output', 'exit']);
    await expect(f.view.resize(120, 40)).resolves.toBeUndefined();
    await expect(f.view.input('after exit')).rejects.toThrow(/unavailable/);
    expect(f.reconnect).not.toHaveBeenCalled();
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual([
      'snapshot',
      'resize',
    ]);
  } finally {
    await f.close();
  }
});

it.each(['queued', 'in-flight'] as const)(
  'ignores a %s resize when its terminal exits',
  async (phase) => {
    const f = fixture();
    try {
      const start = f.view.start(100, 30);
      f.finish();
      await start;
      let reject!: (error: Error) => void;
      if (phase === 'in-flight')
        f.client.request.mockImplementationOnce(
          () =>
            new Promise((_, fail) => {
              reject = fail;
            }),
        );
      const resizing = f.view.resize(120, 40);
      if (phase === 'in-flight') await Promise.resolve();
      f.client.emit('event', {
        t: 'exit',
        cursor: 6,
        term: 'agent',
        generation: f.generation,
        exit_code: 0,
      } satisfies RuntimeEvent);
      f.connections.emit('disconnected', f.binding.runtime_id);
      if (phase === 'in-flight') reject(new Error('Owner stopped'));
      await expect(resizing).resolves.toBeUndefined();
      expect(f.reconnect).not.toHaveBeenCalled();
      expect(f.client.request).toHaveBeenCalledTimes(phase === 'in-flight' ? 3 : 2);
    } finally {
      await f.close();
    }
  },
);

it('still reconnects if shutdown interrupts an unfinished snapshot despite an exit event', async () => {
  const f = fixture();
  try {
    const start = f.view.start(100, 30);
    f.client.emit('event', {
      t: 'exit',
      cursor: 6,
      term: 'agent',
      generation: f.generation,
      exit_code: 0,
    } satisfies RuntimeEvent);
    f.connections.emit('disconnected', f.binding.runtime_id);
    f.finish();
    await start;
    expect(f.reconnect).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    await f.close();
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
    await expect(f.view.resize(120, 40)).resolves.toBeUndefined();
    expect(f.client.request.mock.calls.map(([request]) => request.t)).toEqual(['snapshot']);
    expect(f.reconnect).not.toHaveBeenCalled();
    await expect(f.view.input('after exit')).rejects.toThrow(/unavailable/);
  } finally {
    await f.close();
  }
});

it('keeps historical snapshots readable when the browser resizes without allowing input', async () => {
  const f = fixture();
  const send = vi.fn();
  const reconnect = vi.fn();
  const view = new RuntimeTerminalView(f.terminals, f.view.address, null, {
    valid: () => true,
    send,
    reconnect,
  });
  try {
    vi.spyOn(f.terminals, 'checkpoint').mockResolvedValue('historical screen');
    await view.start(100, 30);
    await expect(view.resize(120, 40)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'replay', data: 'historical screen' }),
    );
    expect(f.client.request).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    await expect(view.input('must not execute')).rejects.toThrow(/unavailable/);
  } finally {
    view.dispose();
    await f.close();
  }
});
