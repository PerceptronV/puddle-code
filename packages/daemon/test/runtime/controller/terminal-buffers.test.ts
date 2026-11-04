import { expect, it, vi } from 'vitest';
import type { RuntimeResponse } from '@puddle/shared';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';
import {
  RuntimeTerminalBuffers,
  TERMINAL_SNAPSHOT_BYTES,
  terminalInputBytes,
  terminalOutputBytes,
} from '../../../src/runtime/controller/terminals/buffers.js';
import { terminalViewFixture } from '../../helpers/runtime/terminal-view.js';

function buffers(pool: 'snapshots' | 'output' | 'input', bytes: number, count: number) {
  return { ...new RuntimeTerminalBuffers(), [pool]: new RuntimeBufferBudget({ bytes, count }) };
}

it('bounds simultaneous snapshots across viewers and retains disposed reads until settlement', async () => {
  const f = terminalViewFixture(buffers('snapshots', TERMINAL_SNAPSHOT_BYTES, 1));
  try {
    const first = f.view.start(80, 24);
    f.view.dispose();
    await f.view.start(80, 24); // No duplicate read, including after disposal.
    const second = f.open();
    await second.view.start(80, 24);
    expect(second.reconnect).toHaveBeenCalledTimes(1);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(f.buffers.snapshots.usedCount).toBe(1);
    f.finish();
    await first;
    expect(f.buffers.snapshots.usedBytes).toBe(0);
    expect(f.send).not.toHaveBeenCalled();
    const third = f.open();
    await third.view.start(80, 24);
    expect(third.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'replay' }));
    expect(third.reconnect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('releases failed snapshots without admitting another read before failure settles', async () => {
  const f = terminalViewFixture();
  try {
    let reject!: (error: Error) => void;
    f.client.request.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const start = f.view.start(80, 24);
    const result = expect(start).rejects.toThrow('snapshot lost');
    f.view.dispose();
    expect(f.buffers.snapshots.usedCount).toBe(1);
    reject(new Error('snapshot lost'));
    await result;
    expect(f.buffers.snapshots.usedCount).toBe(0);
    expect(f.buffers.output.usedCount).toBe(0);
  } finally {
    await f.close();
  }
});

it('bounds aggregate replay behind snapshots and disconnects only the overflowing viewer', async () => {
  const text = '🌊';
  const f = terminalViewFixture(buffers('output', terminalOutputBytes(text), 1));
  try {
    const second = f.open();
    const starts = [f.view.start(80, 24), second.view.start(80, 24)];
    f.output(3, text);
    expect(f.reconnect).not.toHaveBeenCalled();
    expect(second.reconnect).toHaveBeenCalledTimes(1);
    expect(f.buffers.output.usedCount).toBe(1);
    f.finish();
    await Promise.all(starts);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
    expect(f.buffers.output.usedBytes).toBe(0);
    await f.view.input('still live');
    expect(f.client.request.mock.calls.some(([r]) => r.t === 'kill-terminal')).toBe(false);
  } finally {
    await f.close();
  }
});

it('charges JS text and join copies across live viewers and releases after send or disposal', async () => {
  const text = 'ascii';
  expect(terminalOutputBytes(text)).toBeGreaterThan(2 * Buffer.byteLength(text));
  const f = terminalViewFixture(buffers('output', terminalOutputBytes(text), 1));
  try {
    const second = f.open();
    const starts = [f.view.start(80, 24), second.view.start(80, 24)];
    f.finish();
    await Promise.all(starts);
    const counts: number[] = [];
    f.send.mockImplementation((message) => {
      if (message.t !== 'output') return;
      counts.push(f.buffers.output.usedCount);
      f.view.dispose();
      counts.push(f.buffers.output.usedCount); // The flush still retains its local batch.
    });
    f.output(6, text);
    expect(second.reconnect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.buffers.output.usedCount).toBe(0));
    expect(counts).toEqual([1, 1]);
    expect(f.reconnect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('keeps replay reservations through reentrant disposal and releases all discarded events', async () => {
  const f = terminalViewFixture();
  try {
    const start = f.view.start(80, 24);
    f.output(6, 'x'.repeat(64 * 1024));
    f.output(7, 'discard me');
    const counts: number[] = [];
    f.send.mockImplementation((message) => {
      if (message.t !== 'output') return;
      f.view.dispose();
      // Two drained replay events plus the flushing output batch remain retained.
      counts.push(f.buffers.output.usedCount);
    });
    f.finish();
    await start;
    expect(counts).toEqual([3]);
    expect(f.send.mock.calls.map(([message]) => message.t)).toEqual(['replay', 'output']);
    expect(f.buffers.output.usedBytes).toBe(0);
    expect(f.buffers.snapshots.usedBytes).toBe(0);
  } finally {
    await f.close();
  }
});

it('keeps input available while output capacity is full and frees unsent batches on disposal', async () => {
  const f = terminalViewFixture(buffers('output', terminalOutputBytes('pending'), 1));
  try {
    const start = f.view.start(80, 24);
    f.finish();
    await start;
    f.output(6, 'pending');
    expect(f.buffers.output.usedCount).toBe(1);
    await f.view.input('responsive input');
    expect(f.client.request).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'input' }));
    f.view.dispose();
    expect(f.buffers.output.usedCount).toBe(0);
    expect(f.buffers.input.usedCount).toBe(0);
    expect(f.send.mock.calls.map(([message]) => message.t)).toEqual(['replay']);
  } finally {
    await f.close();
  }
});

it('bounds zero-byte actions across viewers and retains disposed queued closures until settlement', async () => {
  const f = terminalViewFixture(buffers('input', 1024, 2));
  try {
    const second = f.open();
    const starts = [f.view.start(80, 24), second.view.start(80, 24)];
    f.finish();
    await Promise.all(starts);
    let settle!: (response: RuntimeResponse) => void;
    f.client.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const first = f.view.resize(100, 30);
    const queued = f.view.resize(101, 31);
    const outcomes = Promise.allSettled([first, queued]);
    await Promise.resolve();
    f.view.dispose();
    expect(f.buffers.input.usedCount).toBe(2);
    await expect(second.view.resize(120, 40)).rejects.toThrow(/unavailable/);
    expect(second.reconnect).toHaveBeenCalledTimes(1);
    expect(f.buffers.input.usedCount).toBe(2);
    settle({ t: 'ok', id: '00000000-0000-4000-8000-000000000000' });
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.buffers.input.usedBytes).toBe(0);
    expect(f.client.request.mock.calls.filter(([r]) => r.t === 'resize')).toHaveLength(3);
  } finally {
    await f.close();
  }
});

it('retains Unicode paste capacity during slow requests and never replays discarded input', async () => {
  const paste = '🌊'.repeat(20_000);
  const f = terminalViewFixture(buffers('input', terminalInputBytes(paste), 10));
  try {
    const second = f.open();
    const starts = [f.view.start(80, 24), second.view.start(80, 24)];
    f.finish();
    await Promise.all(starts);
    let settle!: (response: RuntimeResponse) => void;
    f.client.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const first = f.view.input(paste);
    const outcome = expect(first).rejects.toThrow(/unavailable/);
    await Promise.resolve();
    f.view.dispose();
    await expect(second.view.input('must not run')).rejects.toThrow(/unavailable/);
    expect(f.buffers.input.usedBytes).toBe(terminalInputBytes(paste));
    settle({ t: 'ok', id: '00000000-0000-4000-8000-000000000000' });
    await outcome;
    expect(f.buffers.input.usedBytes).toBe(0);
    expect(f.client.request.mock.calls.filter(([r]) => r.t === 'input')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
