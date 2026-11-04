import type { Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { RuntimeBufferBudget } from '../resources/budget.js';

// Shared by every runtime connection in this process. These bound transport
// buffers, not decoded state, provider processes or total host memory.
const incomingFrames = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 256 });
const outgoingFrames = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 256 });
const writes = new WeakMap<Socket, Set<() => void>>();

/** A four-byte big-endian byte length followed by one UTF-8 JSON object. */
export function encodeRuntimeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > RUNTIME_LIMITS.frameBytes) {
    throw new Error('Runtime frame exceeds its byte limit');
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}

/** Handles arbitrary byte boundaries without quadratic concatenation or UTF-8 loss. */
export function readRuntimeFrames(
  socket: Socket,
  receive: (value: unknown) => void,
  fail: (error: Error) => void,
  budget = incomingFrames,
): () => void {
  const header = Buffer.alloc(4);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let headerUsed = 0;
  let body: Buffer | null = null;
  let bodyUsed = 0;
  let failed = false;
  let releaseBody: (() => void) | null = null;
  const clearBody = () => {
    body = null;
    releaseBody?.();
    releaseBody = null;
  };
  const onData = (chunk: Buffer) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length && !failed) {
        if (body === null) {
          const count = Math.min(4 - headerUsed, chunk.length - offset);
          chunk.copy(header, headerUsed, offset, offset + count);
          offset += count;
          headerUsed += count;
          if (headerUsed !== 4) continue;
          const length = header.readUInt32BE();
          if (length === 0 || length > RUNTIME_LIMITS.frameBytes)
            throw new Error('Invalid runtime frame length');
          releaseBody = budget.reserve(length);
          if (!releaseBody) throw new Error('Runtime receive buffer capacity exhausted');
          body = Buffer.allocUnsafe(length);
          bodyUsed = 0;
        }
        const count = Math.min(body.length - bodyUsed, chunk.length - offset);
        chunk.copy(body, bodyUsed, offset, offset + count);
        offset += count;
        bodyUsed += count;
        if (bodyUsed !== body.length) continue;
        const value: unknown = JSON.parse(decoder.decode(body));
        clearBody();
        headerUsed = 0;
        receive(value);
      }
    } catch (error) {
      failed = true;
      clearBody();
      fail(error instanceof Error ? error : new Error('Invalid runtime frame'));
    }
  };
  socket.on('data', onData);
  const stop = () => {
    failed = true;
    clearBody();
    socket.off('data', onData);
    socket.off('close', stop);
  };
  socket.once('close', stop);
  return stop;
}

/** A slow controller loses its connection, never the runtime's PTY output. */
export function writeRuntimeFrame(
  socket: Socket,
  value: unknown,
  budget = outgoingFrames,
): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const frame = encodeRuntimeFrame(value);
  if (socket.writableLength + frame.length > RUNTIME_LIMITS.queuedBytes) {
    socket.destroy();
    return false;
  }
  const release = budget.reserve(frame.length);
  if (!release) {
    socket.destroy();
    return false;
  }
  let pending = writes.get(socket);
  if (!pending) {
    pending = new Set();
    writes.set(socket, pending);
    const queued = pending;
    socket.once('close', () => {
      for (const complete of queued) complete();
      writes.delete(socket);
    });
  }
  const queued = pending;
  const complete = () => {
    queued.delete(complete);
    release();
  };
  pending.add(complete);
  try {
    socket.write(frame, (error) => {
      complete();
      if (error) socket.destroy();
    });
  } catch (error) {
    complete();
    throw error;
  }
  return true;
}
