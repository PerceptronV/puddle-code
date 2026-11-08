import { timingSafeEqual } from 'node:crypto';
import type { Server, Socket } from 'node:net';
import {
  canonicalHuddleJson,
  huddleOwnerRequestSchema,
  RUNTIME_LIMITS,
  type HuddleOwnerLaunch,
  type HuddleOwnerRequest,
  type HuddleOwnerResponse,
} from '@puddle/shared';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { readRuntimeController } from '../../ownership/storage.js';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../resources/budget.js';
import { RuntimeTransportBuffers } from '../../transport/buffers.js';
import { runtimeJsonRetainedBytes } from '../../transport/encoding.js';
import { readRuntimeFrames, writeRuntimeFrame } from '../../transport/framing.js';
import { RuntimeRequestQueue } from '../../transport/requests.js';

/** Private controller transport; loss of its socket does not stop the huddle. */
export class HuddleOwnerServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly queues = new Set<RuntimeRequestQueue>();
  private readonly buffers: RuntimeTransportBuffers;
  private readonly requests: RuntimeBufferBudget;
  private controller: { socket: Socket; id: string; epoch: number } | null = null;
  private closed = false;
  private cursor = 0;
  constructor(
    private readonly home: string,
    private readonly launch: HuddleOwnerLaunch,
    allowance: RuntimeByteAllowance,
    private readonly execute: (request: HuddleOwnerRequest) => Promise<HuddleOwnerResponse>,
  ) {
    this.buffers = new RuntimeTransportBuffers(allowance);
    this.requests = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 64 }, allowance);
  }
  get commandCursor() {
    return this.cursor;
  }
  async listen() {
    this.server = await listenPrivate(
      ipcPath(this.home, `runtime:${this.launch.identity.runtime_id}`),
      (socket) => this.accept(socket),
    );
  }
  private authorised(id: string, epoch: number) {
    try {
      const current = readRuntimeController(this.home);
      return current.active && current.id === id && current.epoch === epoch;
    } catch {
      return false;
    }
  }
  private accept(socket: Socket) {
    if (this.closed || this.sockets.size >= 16) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), RUNTIME_LIMITS.handshakeMs);
    const queue = new RuntimeRequestQueue(
      this.requests,
      () => !socket.destroyed && !this.closed,
      () => socket.destroy(),
    );
    this.queues.add(queue);
    readRuntimeFrames(
      socket,
      (raw) => {
        const request = huddleOwnerRequestSchema.parse(raw);
        if (
          !queue.enqueue(runtimeJsonRetainedBytes(request), async () => {
            const fail = (code: 'fenced' | 'duplicate' | 'rejected', message: string) =>
              this.reply(socket, { t: 'error', id: request.id, code, message });
            if (request.t === 'hello') {
              if (
                canonicalHuddleJson(request.identity) !==
                  canonicalHuddleJson(this.launch.identity) ||
                !timingSafeEqual(
                  Buffer.from(request.secret, 'hex'),
                  Buffer.from(this.launch.secret, 'hex'),
                ) ||
                !this.authorised(request.controllerId, request.controllerEpoch)
              ) {
                fail('fenced', 'Huddle controller authority rejected');
                return;
              }
              if (this.controller?.socket !== socket) this.controller?.socket.destroy();
              this.controller = {
                socket,
                id: request.controllerId,
                epoch: request.controllerEpoch,
              };
              clearTimeout(timer);
            } else {
              const controller = this.controller;
              if (
                controller?.socket !== socket ||
                !this.authorised(controller.id, controller.epoch)
              ) {
                fail('fenced', 'Huddle controller is no longer current');
                return;
              }
              if (request.sequence <= this.cursor) {
                fail('duplicate', 'Huddle command was already admitted');
                return;
              }
              // Survives controller replacement. A consumed launch cannot restart this incarnation.
              this.cursor = request.sequence;
            }
            try {
              this.reply(socket, await this.execute(request));
            } catch {
              fail(
                'rejected',
                'Huddle command failed; inspect retained state before another mutation',
              );
            }
          })
        )
          socket.destroy();
      },
      () => socket.destroy(),
      this.buffers.incoming,
      this.buffers.decoding,
    );
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (this.controller?.socket === socket) this.controller = null;
      void queue.settled.then(() => this.queues.delete(queue));
    });
  }
  private reply(socket: Socket, value: HuddleOwnerResponse) {
    writeRuntimeFrame(socket, value, this.buffers.outgoing, this.buffers.encoding);
  }
  async close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
    this.server = null;
    await Promise.all([...this.queues].map((queue) => queue.settled));
  }
}
