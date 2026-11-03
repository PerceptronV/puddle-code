import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import {
  encodeRuntimeFrame,
  readRuntimeFrames,
  writeRuntimeFrame,
} from '../../src/runtime/framing.js';

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
});
