import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import {
  encodeRuntimeFrame,
  readRuntimeFrames,
  writeRuntimeFrame,
} from '../../../src/runtime/transport/framing.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';

/** A genuinely backpressured Writable: writes complete only when the test drains them. */
class SlowSocket extends Socket {
  callbacks: Array<(error?: Error | null) => void> = [];
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.callbacks.push(callback);
  }
  drainOne() {
    this.callbacks.shift()?.();
  }
}

describe('runtime framing', () => {
  it('retains Unicode when every byte arrives separately and handles coalesced frames', () => {
    const socket = new Socket();
    const received: unknown[] = [];
    const errors: Error[] = [];
    const stop = readRuntimeFrames(
      socket,
      (value) => received.push(value),
      (error) => errors.push(error),
    );
    const first = { text: 'terminal 🦆 café 漢字' };
    for (const byte of encodeRuntimeFrame(first)) socket.emit('data', Buffer.from([byte]));
    socket.emit(
      'data',
      Buffer.concat([encodeRuntimeFrame({ n: 1 }), encodeRuntimeFrame({ n: 2 })]),
    );
    expect(received).toEqual([first, { n: 1 }, { n: 2 }]);
    expect(errors).toEqual([]);
    stop();
    expect(socket.listenerCount('data')).toBe(0);
    socket.destroy();
  });

  it.each([0, RUNTIME_LIMITS.frameBytes + 1, 0xffffffff])(
    'rejects invalid length %i before buffering a body',
    (length) => {
      const socket = new Socket();
      const errors: Error[] = [];
      let received = 0;
      const stop = readRuntimeFrames(
        socket,
        () => received++,
        (error) => errors.push(error),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      socket.emit('data', header);
      socket.emit('data', encodeRuntimeFrame({ after: true }));
      expect(errors).toHaveLength(1);
      expect(received).toBe(0);
      stop();
      socket.destroy();
    },
  );

  it('rejects malformed UTF-8 rather than replacing bytes in a command', () => {
    const socket = new Socket();
    const errors: Error[] = [];
    const stop = readRuntimeFrames(
      socket,
      () => {
        throw new Error('Unexpected decoded frame');
      },
      (error) => errors.push(error),
    );
    socket.emit('data', Buffer.from([0, 0, 0, 3, 0x22, 0xff, 0x22]));
    expect(errors).toHaveLength(1);
    stop();
    socket.destroy();
  });

  it('applies the bound to encoded bytes, not string characters', () => {
    expect(() => encodeRuntimeFrame({ text: '🦆'.repeat(RUNTIME_LIMITS.frameBytes / 4) })).toThrow(
      /byte limit/,
    );
  });

  it('drops a slow controller without queuing another frame', () => {
    const socket = new Socket();
    Object.defineProperty(socket, 'writableLength', { value: RUNTIME_LIMITS.queuedBytes });
    expect(writeRuntimeFrame(socket, { text: 'next' })).toBe(false);
    expect(socket.destroyed).toBe(true);
  });

  it('bounds partial frame allocations across sockets and releases on completion, failure and close', async () => {
    const budget = new RuntimeBufferBudget({ bytes: 64, count: 2 });
    const sockets = Array.from({ length: 4 }, () => new Socket());
    const failures = sockets.map(() => vi.fn());
    const received = vi.fn();
    const stops = sockets.map((socket, index) =>
      readRuntimeFrames(socket, received, failures[index]!, budget),
    );
    const frame = encodeRuntimeFrame({ text: 'x'.repeat(20) });
    try {
      sockets[0]!.emit('data', frame.subarray(0, 4));
      sockets[1]!.emit('data', frame.subarray(0, 4));
      expect(budget.usedBytes).toBe(2 * (frame.length - 4));
      sockets[2]!.emit('data', frame.subarray(0, 4));
      expect(failures[2]).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/capacity/) }),
      );
      expect(budget.usedCount).toBe(2);
      sockets[0]!.emit('data', frame.subarray(4));
      expect(received).toHaveBeenCalledOnce();
      expect(budget.usedCount).toBe(1);
      // A failed stream does not recover or accept a later command implicitly.
      sockets[2]!.emit('data', frame);
      expect(received).toHaveBeenCalledOnce();
      sockets[3]!.emit('data', Buffer.from([0, 0, 0, 3, 0x22, 0xff, 0x22]));
      expect(failures[3]).toHaveBeenCalledOnce();
      expect(budget.usedCount).toBe(1);
      sockets[1]!.destroy();
      await vi.waitFor(() => expect(budget.usedBytes).toBe(0));
      stops[1]!();
      expect(budget.usedCount).toBe(0);
    } finally {
      for (const stop of stops) stop();
      for (const socket of sockets) socket.destroy();
    }
  });

  it('bounds aggregate queued writes without disconnecting other owners and reclaims drained capacity', async () => {
    const frame = { text: 'held output' };
    const bytes = encodeRuntimeFrame(frame).length;
    const budget = new RuntimeBufferBudget({ bytes: 2 * bytes, count: 8 });
    const sockets = Array.from({ length: 4 }, () => new SlowSocket());
    try {
      expect(writeRuntimeFrame(sockets[0]!, frame, budget)).toBe(true);
      expect(writeRuntimeFrame(sockets[1]!, frame, budget)).toBe(true);
      expect(budget.usedBytes).toBe(2 * bytes);
      expect(writeRuntimeFrame(sockets[2]!, frame, budget)).toBe(false);
      expect(sockets[2]!.destroyed).toBe(true);
      expect(sockets[0]!.destroyed).toBe(false);
      expect(sockets[1]!.destroyed).toBe(false);
      sockets[0]!.drainOne();
      expect(budget.usedBytes).toBe(bytes);
      expect(writeRuntimeFrame(sockets[3]!, frame, budget)).toBe(true);
      sockets[1]!.destroy();
      await vi.waitFor(() => expect(budget.usedBytes).toBe(bytes));
      // A late write callback after close must not release another frame's charge.
      sockets[1]!.drainOne();
      expect(budget.usedBytes).toBe(bytes);
      sockets[3]!.drainOne();
      expect(budget.usedCount).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('bounds the count of small queued frames and releases a synchronous write failure', async () => {
    const budget = new RuntimeBufferBudget({ bytes: 1024, count: 2 });
    const socket = new SlowSocket();
    const failed = new Socket();
    try {
      vi.spyOn(failed, 'write').mockImplementation(() => {
        throw new Error('write failed');
      });
      expect(() => writeRuntimeFrame(failed, {}, budget)).toThrow('write failed');
      expect(budget.usedCount).toBe(0);
      expect(writeRuntimeFrame(socket, {}, budget)).toBe(true);
      expect(writeRuntimeFrame(socket, {}, budget)).toBe(true);
      expect(socket.listenerCount('close')).toBe(1);
      expect(writeRuntimeFrame(socket, {}, budget)).toBe(false);
      await vi.waitFor(() => expect(budget.usedCount).toBe(0));
      socket.drainOne();
      expect(budget.usedBytes).toBe(0);
    } finally {
      socket.destroy();
      failed.destroy();
    }
  });

  it.each(['aggregate', 'socket'] as const)(
    'refuses %s capacity before serialising or allocating a frame',
    (scope) => {
      const socket = new Socket();
      const budget = new RuntimeBufferBudget({ bytes: scope === 'aggregate' ? 0 : 1024, count: 2 });
      if (scope === 'socket')
        Object.defineProperty(socket, 'writableLength', { value: RUNTIME_LIMITS.queuedBytes });
      const stringify = vi.spyOn(JSON, 'stringify');
      const allocate = vi.spyOn(Buffer, 'allocUnsafe');
      try {
        expect(writeRuntimeFrame(socket, { text: 'no room' }, budget)).toBe(false);
        expect(stringify).not.toHaveBeenCalled();
        expect(allocate).not.toHaveBeenCalled();
        expect(budget.usedBytes).toBe(0);
        expect(socket.destroyed).toBe(true);
      } finally {
        stringify.mockRestore();
        allocate.mockRestore();
        socket.destroy();
      }
    },
  );

  it('holds exact small-frame charges across a healthy burst rather than maximum encoding allowances', async () => {
    const value = { text: 'small 🦆 burst' };
    const bytes = encodeRuntimeFrame(value).length;
    const budget = new RuntimeBufferBudget({ bytes: bytes * 64, count: 64 });
    const socket = new SlowSocket();
    try {
      for (let index = 0; index < 64; index++)
        expect(writeRuntimeFrame(socket, value, budget)).toBe(true);
      expect(socket.destroyed).toBe(false);
      expect(socket.writableLength).toBe(bytes * 64);
      expect(budget.usedBytes).toBe(bytes * 64);
      for (let index = 0; index < 64; index++) {
        socket.drainOne();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(budget.usedBytes).toBe(0);
      expect(budget.usedCount).toBe(0);
    } finally {
      socket.destroy();
    }
  });

  it('releases exact frame and transient capacity after an encoder failure', () => {
    const socket = new SlowSocket();
    const bytes = encodeRuntimeFrame({}).length;
    const budget = new RuntimeBufferBudget({ bytes, count: 1 });
    const allocate = vi.spyOn(Buffer, 'allocUnsafe').mockImplementationOnce(() => {
      throw new Error('allocation failed');
    });
    try {
      expect(() => writeRuntimeFrame(socket, {}, budget)).toThrow('allocation failed');
      expect(budget.usedBytes).toBe(0);
      expect(budget.usedCount).toBe(0);
    } finally {
      allocate.mockRestore();
    }
    try {
      expect(writeRuntimeFrame(socket, {}, budget)).toBe(true);
      socket.drainOne();
      expect(budget.usedBytes).toBe(0);
    } finally {
      socket.destroy();
    }
  });
});
