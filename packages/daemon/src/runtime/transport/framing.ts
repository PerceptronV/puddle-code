import type { Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import { RUNTIME_LIMITS } from '@puddle/shared';
import type { RuntimeBufferBudget } from '../resources/budget.js';
import { runtimeJsonBytes } from './encoding.js';
import { RuntimeTransportBuffers } from './buffers.js';
import { runtimeJsonDecodeBytes } from './decoding.js';

// Shared by every runtime connection in this process. These bound transport
// buffers, not decoded state, provider processes or total host memory.
const buffers = new RuntimeTransportBuffers();
const writes = new WeakMap<Socket, Set<() => void>>();

function encodeMeasuredFrame(
  value: unknown,
  bytes: number,
  encoding: RuntimeBufferBudget,
): Buffer | null {
  const release = encoding.reserve(4 * bytes);
  if (!release) return null;
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) !== bytes)
      throw new Error('Runtime JSON changed during encoding');
    const frame = Buffer.allocUnsafe(4 + bytes);
    frame.writeUInt32BE(bytes);
    frame.write(json, 4, bytes, 'utf8');
    return frame;
  } finally {
    release();
  }
}

/** A four-byte big-endian byte length followed by one UTF-8 schema JSON value. */
export function encodeRuntimeFrame(value: unknown): Buffer {
  const frame = encodeMeasuredFrame(value, runtimeJsonBytes(value), buffers.encoding);
  if (!frame) throw new Error('Runtime encoding buffer capacity exhausted');
  return frame;
}

/** Handles arbitrary byte boundaries without quadratic concatenation or UTF-8 loss. */
export function readRuntimeFrames(
  socket: Socket,
  receive: (value: unknown) => void,
  fail: (error: Error) => void,
  budget = buffers.incoming,
  decoding = buffers.decoding,
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
          body = Buffer.allocUnsafeSlow(length);
          bodyUsed = 0;
        }
        const count = Math.min(body.length - bodyUsed, chunk.length - offset);
        chunk.copy(body, bodyUsed, offset, offset + count);
        offset += count;
        bodyUsed += count;
        if (bodyUsed !== body.length) continue;
        // Detach the completed frame's ownership: stop/close during receive
        // cannot refund it before synchronous schema/queue admission finishes.
        const complete = body;
        const releaseComplete = releaseBody!;
        body = null;
        releaseBody = null;
        headerUsed = 0;
        let releaseDecode: (() => void) | null = null;
        try {
          releaseDecode = decoding.reserve(runtimeJsonDecodeBytes(complete));
          if (!releaseDecode) throw new Error('Runtime decode buffer capacity exhausted');
          const value: unknown = JSON.parse(decoder.decode(complete));
          receive(value);
        } finally {
          releaseDecode?.();
          releaseComplete();
        }
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
  budget = buffers.outgoing,
  encoding = buffers.encoding,
): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const bytes = runtimeJsonBytes(value) + 4;
  if (socket.writableLength + bytes > RUNTIME_LIMITS.queuedBytes) {
    socket.destroy();
    return false;
  }
  const release = budget.reserve(bytes);
  if (!release) {
    socket.destroy();
    return false;
  }
  let frame: Buffer;
  try {
    const encoded = encodeMeasuredFrame(value, bytes - 4, encoding);
    if (!encoded) {
      release();
      socket.destroy();
      return false;
    }
    frame = encoded;
  } catch (error) {
    release();
    throw error;
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
