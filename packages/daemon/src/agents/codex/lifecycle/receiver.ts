import type { Socket } from 'node:net';
import type { WebSocket } from 'ws';
import type { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';

type Callback = (error?: Error | null) => void;
interface Receiver {
  _write(chunk: Buffer, encoding: BufferEncoding, callback: Callback): void;
  startLoop(callback: Callback): void;
  emit(event: string, ...args: unknown[]): boolean;
  _loop: boolean;
  _allowSynchronousEvents: boolean;
  _binaryType: string;
  _extensions: Record<string, unknown>;
  _compressed: boolean;
  _bufferedBytes: number;
  _buffers: Buffer[];
  _fragments: Buffer[];
  _fragmented: number;
  _messageLength: number;
  _totalPayloadLength: number;
  _state: number;
  writableLength: number;
}
export interface CodexReceiverFlow {
  /** Retry only work which has not been sent or otherwise consumed. */
  defer(retry: () => boolean, retainMessage?: boolean): void;
  /** Transfer admitted receive capacity to a downstream sender callback. */
  retain(): () => void;
}

/**
 * Instance-only ws 8.21.0 guard. Compression/deferred events are disabled, so
 * stopping _loop in a message callback leaves GET_INFO and a resumable callback.
 * Node 22.21.1's libuv TCP reads are 64 KiB; the validated socket high-water mark
 * bounds close-time buffered reads too. One pending 128 KiB raw slot per leg is
 * covered by the owner's essential envelope, never by an unbounded input queue.
 */
export function guardCodexReceiver(
  socket: WebSocket,
  budget: RuntimeBufferBudget,
  failed: (error: Error) => void,
): CodexReceiverFlow {
  const internals = socket as unknown as { _receiver?: Receiver; _socket?: Socket };
  const receiver = internals._receiver;
  const stream = internals._socket;
  if (
    !receiver ||
    !stream ||
    stream.readableHighWaterMark > 64 * 1024 ||
    typeof receiver._write !== 'function' ||
    typeof receiver.startLoop !== 'function' ||
    typeof receiver.emit !== 'function' ||
    typeof receiver._loop !== 'boolean' ||
    receiver._allowSynchronousEvents !== true ||
    receiver._binaryType !== 'nodebuffer' ||
    !receiver._extensions ||
    Object.keys(receiver._extensions).length !== 0 ||
    receiver._compressed !== false ||
    receiver.writableLength !== 0 ||
    !Array.isArray(receiver._buffers) ||
    !Array.isArray(receiver._fragments) ||
    receiver._buffers.length !== 0 ||
    receiver._fragments.length !== 0 ||
    receiver._bufferedBytes !== 0 ||
    receiver._fragmented !== 0 ||
    receiver._messageLength !== 0 ||
    receiver._totalPayloadLength !== 0 ||
    receiver._state !== 0
  )
    throw new Error('Unsupported Codex WebSocket receiver state');
  const original = receiver._write;
  interface Chunk {
    buffer: Buffer;
    live: boolean;
    references: number;
    release(): void;
  }
  const held = new Set<Chunk>();
  let depth = 0,
    closed = false;
  let callback: Callback | null = null;
  let raw: { chunk: Buffer; encoding: BufferEncoding } | null = null;
  let work: (() => boolean) | null = null;
  let workHold: { chunks: Set<Chunk>; release(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 25;
  const consumed = () => {
    const ranges = new Map<ArrayBufferLike, Array<[number, number]>>();
    for (const buffer of receiver._buffers) {
      const list = ranges.get(buffer.buffer) ?? [];
      list.push([buffer.byteOffset, buffer.byteOffset + buffer.byteLength]);
      ranges.set(buffer.buffer, list);
    }
    for (const entry of held) {
      if (!entry.live) continue;
      const start = entry.buffer.byteOffset,
        end = start + entry.buffer.byteLength;
      entry.live = ranges.get(entry.buffer.buffer)?.some(([a, b]) => a < end && b > start) ?? false;
    }
  };
  const release = () => {
    if (depth) return;
    if (closed) {
      receiver._buffers.length = 0;
      receiver._fragments.length = 0;
      receiver._bufferedBytes = 0;
      receiver._messageLength = 0;
      receiver._totalPayloadLength = 0;
      receiver._fragmented = 0;
      for (const entry of held) entry.live = false;
    } else if (!receiver._bufferedBytes && !receiver._fragments.length && !receiver._fragmented)
      consumed();
    for (const entry of held)
      if (!entry.live && !entry.references) {
        held.delete(entry);
        entry.release();
      }
  };
  const emit = receiver.emit;
  receiver.emit = function (event, ...args) {
    if (event !== 'message') return emit.call(this, event, ...args);
    try {
      return emit.call(this, event, ...args);
    } finally {
      // A completed message has detached its fragments before emission. Its
      // concatenated buffers remain backed by explicit pending/forward leases.
      // Retain only unread raw input for the next message; a partial next frame
      // must not pin every previous message's credits indefinitely.
      consumed();
    }
  };
  const retain = () => {
    const chunks = new Set([...held].filter((entry) => entry.live || workHold?.chunks.has(entry)));
    for (const entry of chunks) entry.references++;
    let active = true;
    return {
      chunks,
      release: () => {
        if (!active) return;
        active = false;
        for (const entry of chunks) entry.references--;
        release();
      },
    };
  };
  const complete: Callback = (error) => {
    if (!error && (work || raw)) return;
    const done = callback;
    callback = null;
    done?.(error);
  };
  const parse = (start: () => void) => {
    depth++;
    try {
      start();
    } catch (error) {
      failed(error instanceof Error ? error : new Error('Codex parser failed'));
      complete(error instanceof Error ? error : new Error('Codex parser failed'));
    } finally {
      depth--;
      release();
    }
  };
  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      retry();
    }, delay);
    timer.unref();
    delay = Math.min(1000, delay * 2);
  };
  const retry = () => {
    if (closed) return;
    if (raw) {
      const charge = budget.reserve(8 * raw.chunk.length + 256);
      if (!charge) {
        schedule();
        return;
      }
      held.add({ buffer: raw.chunk, live: true, references: 0, release: charge });
      const input = raw;
      raw = null;
      parse(() => original.call(receiver, input.chunk, input.encoding, complete));
    } else if (work) {
      let ready: boolean;
      try {
        ready = work();
      } catch (error) {
        failed(error instanceof Error ? error : new Error('Codex pending delivery failed'));
        return;
      }
      if (!ready) {
        schedule();
        return;
      }
      work = null;
      const previous = workHold;
      workHold = null;
      previous?.release();
      parse(() => receiver.startLoop(complete));
    }
    if (work || raw) schedule();
    else {
      delay = 25;
      release();
      if (!closed) socket.resume();
    }
  };
  receiver._write = function (chunk, encoding, done) {
    if (callback || chunk.length > 128 * 1024) {
      const error = new Error('Unsupported Codex TCP receiver chunk');
      failed(error);
      done(error);
      return;
    }
    callback = done;
    const charge = budget.reserve(8 * chunk.length + 256);
    if (!charge) {
      raw = { chunk, encoding };
      socket.pause();
      schedule();
      return;
    }
    held.add({ buffer: chunk, live: true, references: 0, release: charge });
    parse(() => original.call(this, chunk, encoding, complete));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    raw = null;
    work = null;
    const previous = workHold;
    workHold = null;
    previous?.release();
    // ws waits for the receiver's pending callback before emitting its own close.
    complete(new Error('Codex native socket closed'));
    release();
  };
  stream.once('close', close);
  socket.once('close', close);
  return {
    defer(retryWork, retainMessage = true) {
      if (work || !callback || !depth) throw new Error('Unsupported Codex parser suspension');
      workHold = retainMessage ? retain() : null;
      work = retryWork;
      receiver._loop = false;
      socket.pause();
      schedule();
    },
    retain() {
      return retain().release;
    },
  };
}
