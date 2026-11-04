import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  RUNTIME_LIMITS,
  RUNTIME_PROTOCOL_VERSION,
  parseRuntimeMessage,
  runtimeRequestSchema,
  type RuntimeControllerRecord,
  type RuntimeLaunch,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeState,
} from '@puddle/shared';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { readRuntimeFrames, writeRuntimeFrame } from './framing.js';

export class RuntimeConnectionLost extends Error {
  constructor() {
    super(
      'Runtime connection lost; pending mutations have an unknown outcome and were not replayed',
    );
  }
}

/** Only a correlated response from the authenticated owner constructs this evidence. */
export class RuntimeRequestRejected extends Error {
  constructor(
    readonly code: Extract<RuntimeResponse, { t: 'error' }>['code'],
    message: string,
    readonly request: RuntimeRequest['t'],
  ) {
    super(message);
  }
}

type Request = RuntimeRequest extends infer R
  ? R extends RuntimeRequest
    ? Omit<R, 'id' | 'sequence'>
    : never
  : never;
interface Pending {
  request: RuntimeRequest['t'];
  resolve(response: RuntimeResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** One controller connection. Reconnection is explicit and never retries commands. */
export class RuntimeClient extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private stopReading: () => void;
  private closed = false;
  private commandCursor = 0;
  state: RuntimeState | null = null;

  private constructor(private readonly socket: Socket) {
    super();
    this.stopReading = readRuntimeFrames(
      socket,
      (value) => {
        const message = parseRuntimeMessage(value);
        if (message === null) return;
        if (!('id' in message)) {
          this.emit('event', message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.t === 'error') {
          pending.reject(
            new RuntimeRequestRejected(message.code, message.message, pending.request),
          );
        } else {
          if (message.t === 'state') {
            this.state = message.state;
            this.commandCursor = Math.max(this.commandCursor, message.state.command_cursor);
          }
          pending.resolve(message);
        }
      },
      () => this.close(),
    );
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  static async open(
    home: string,
    launch: RuntimeLaunch,
    controller: RuntimeControllerRecord,
  ): Promise<RuntimeClient> {
    const path = ipcPath(home, `runtime:${launch.identity.runtime_id}`);
    privatePath(path);
    const socket = connect(path);
    const client = new RuntimeClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Runtime connection timed out'));
        }, RUNTIME_LIMITS.handshakeMs);
        const clear = () => clearTimeout(timer);
        socket.once('connect', () => {
          clear();
          resolve();
        });
        socket.once('error', (error) => {
          clear();
          reject(error);
        });
      });
      await client.request({
        t: 'hello',
        protocol: RUNTIME_PROTOCOL_VERSION,
        runtime_id: launch.identity.runtime_id,
        incarnation: launch.identity.incarnation,
        secret: launch.secret,
        controller_id: controller.id,
        controller_epoch: controller.epoch,
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(value: Request): Promise<RuntimeResponse> {
    if (this.closed) return Promise.reject(new RuntimeConnectionLost());
    if (this.pending.size >= RUNTIME_LIMITS.pendingRequests)
      return Promise.reject(new Error('Too many pending runtime operations'));
    const request = runtimeRequestSchema.parse({
      ...value,
      id: randomUUID(),
      ...(value.t === 'hello' ? {} : { sequence: this.commandCursor + 1 }),
    });
    if ('sequence' in request) this.commandCursor = request.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout invalidates the stream; callers inspect state after reconnecting.
        this.close();
      }, RUNTIME_LIMITS.requestMs);
      this.pending.set(request.id, { resolve, reject, timer, request: request.t });
      try {
        if (!writeRuntimeFrame(this.socket, request)) this.close();
      } catch (error) {
        this.pending.delete(request.id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopReading();
    this.socket.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RuntimeConnectionLost());
    }
    this.pending.clear();
    this.emit('disconnected');
  }
}
