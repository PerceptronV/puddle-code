import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import {
  canonicalHuddleJson,
  huddleOwnerRequestSchema,
  huddleOwnerResponseSchema,
  RUNTIME_LIMITS,
  supportsHuddleRuntime,
  type HuddleOwnerLaunch,
  type HuddleOwnerRequest,
  type HuddleOwnerResponse,
  type HuddleOwnerState,
  type RuntimeControllerRecord,
} from '@puddle/shared';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { readRuntimeFrames, writeRuntimeFrame } from '../../transport/framing.js';
import { RuntimeConnectionLost } from '../../transport/client.js';

type Command = HuddleOwnerRequest extends infer R
  ? R extends HuddleOwnerRequest
    ? Omit<R, 'id' | 'sequence'>
    : never
  : never;
interface Pending {
  resolve(value: HuddleOwnerResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class HuddleOwnerRejected extends Error {
  constructor(
    readonly code: 'fenced' | 'duplicate' | 'rejected',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Authenticated observation and commands. Neither disconnect nor timeout retries a mutation. */
export class HuddleOwnerClient extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private cursor = 0;
  state: HuddleOwnerState | null = null;
  private constructor(private readonly socket: Socket) {
    super();
    readRuntimeFrames(
      socket,
      (raw) => {
        const response = huddleOwnerResponseSchema.parse(raw);
        if (response.t === 'changed') {
          this.emit('changed', response.observation);
          return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) throw new Error('Uncorrelated huddle owner response');
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.t === 'error')
          pending.reject(new HuddleOwnerRejected(response.code, response.message));
        else {
          if (response.t === 'state') {
            this.state = response.state;
            this.cursor = Math.max(this.cursor, response.state.commandCursor);
          }
          pending.resolve(response);
        }
      },
      () => this.close(),
    );
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }
  static async open(home: string, launch: HuddleOwnerLaunch, controller: RuntimeControllerRecord) {
    if (!supportsHuddleRuntime(launch.capabilities))
      throw new Error('Huddle launch requires unsupported runtime capabilities');
    const path = ipcPath(home, `runtime:${launch.identity.runtime_id}`);
    privatePath(path);
    const socket = connect(path);
    const client = new HuddleOwnerClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Huddle connection timed out'));
        }, RUNTIME_LIMITS.handshakeMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const reply = await client.request({
        t: 'hello',
        role: 'huddle',
        contract: launch.contract,
        identity: launch.identity,
        secret: launch.secret,
        controllerId: controller.id,
        controllerEpoch: controller.epoch,
      });
      if (
        reply.t !== 'state' ||
        canonicalHuddleJson(reply.state.identity) !== canonicalHuddleJson(launch.identity) ||
        canonicalHuddleJson(reply.state.scope) !== canonicalHuddleJson(launch.scope) ||
        reply.state.build !== launch.build ||
        reply.state.contract !== launch.contract ||
        canonicalHuddleJson(reply.state.capabilities) !==
          canonicalHuddleJson(launch.capabilities) ||
        reply.state.lifetime !== launch.lifetime
      )
        throw new Error('Huddle owner does not match its exact launch');
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  request(value: Command): Promise<HuddleOwnerResponse> {
    if (this.closed) return Promise.reject(new RuntimeConnectionLost());
    if (value.t.startsWith('spawn-') && this.state?.capabilities.spawns !== 1)
      return Promise.reject(
        new HuddleOwnerRejected('rejected', 'Owner has no agent-spawn capability'),
      );
    if (this.pending.size >= RUNTIME_LIMITS.pendingRequests)
      return Promise.reject(new Error('Too many huddle requests'));
    const request = huddleOwnerRequestSchema.parse({
      ...value,
      id: randomUUID(),
      ...(value.t === 'hello' ? {} : { sequence: this.cursor + 1 }),
    });
    if ('sequence' in request) this.cursor = request.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), RUNTIME_LIMITS.requestMs);
      this.pending.set(request.id, { resolve, reject, timer });
      try {
        if (!writeRuntimeFrame(this.socket, request)) this.close();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(error);
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeConnectionLost());
    }
    this.pending.clear();
    this.emit('disconnected');
  }
}
