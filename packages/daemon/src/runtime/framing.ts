import type { Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import { RUNTIME_LIMITS } from '@puddle/shared';

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
): () => void {
  const header = Buffer.alloc(4);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let headerUsed = 0;
  let body: Buffer | null = null;
  let bodyUsed = 0;
  let failed = false;
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
          body = Buffer.allocUnsafe(length);
          bodyUsed = 0;
        }
        const count = Math.min(body.length - bodyUsed, chunk.length - offset);
        chunk.copy(body, bodyUsed, offset, offset + count);
        offset += count;
        bodyUsed += count;
        if (bodyUsed !== body.length) continue;
        const value: unknown = JSON.parse(decoder.decode(body));
        body = null;
        headerUsed = 0;
        receive(value);
      }
    } catch (error) {
      failed = true;
      fail(error instanceof Error ? error : new Error('Invalid runtime frame'));
    }
  };
  socket.on('data', onData);
  return () => {
    failed = true;
    body = null;
    socket.off('data', onData);
  };
}

/** A slow controller loses its connection, never the runtime's PTY output. */
export function writeRuntimeFrame(socket: Socket, value: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const frame = encodeRuntimeFrame(value);
  if (socket.writableLength + frame.length > RUNTIME_LIMITS.queuedBytes) {
    socket.destroy();
    return false;
  }
  socket.write(frame);
  return true;
}
