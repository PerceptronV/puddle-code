import { WebSocket } from 'ws';
import { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';
import type { CodexReceiverFlow } from './receiver.js';
import { CODEX_BRIDGE_LIMITS } from './limits.js';
import { runtimeJsonBytes } from '../../../runtime/transport/encoding.js';

export interface CodexPacket {
  data: Buffer;
  binary: boolean;
  release(): void;
}

/** Packet charges transfer from pre-open queues to actual sender callbacks, never to an uncharged gap. */
export class CodexSocketWrites {
  private readonly forwarded = new RuntimeBufferBudget({
    bytes: CODEX_BRIDGE_LIMITS.sendBytes,
    count: CODEX_BRIDGE_LIMITS.sendMessages,
  });
  private readonly pending = new Map<WebSocket, Set<() => void>>();
  constructor(private readonly budget: RuntimeBufferBudget) {}

  forward(data: Buffer, binary: boolean, flow: CodexReceiverFlow): CodexPacket | null {
    const release = this.forwarded.reserve(2 * data.length + 256);
    if (!release) return null;
    const receive = flow.retain();
    return {
      data,
      binary,
      release: () => {
        release();
        receive();
      },
    };
  }

  pong(data: Buffer): CodexPacket | null {
    if (data.length > 125) throw new Error('Invalid Codex ping payload');
    const release = this.budget.reserve(2 * data.length + 256);
    if (!release) return null;
    try {
      return { data: Buffer.from(data), binary: true, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  json(value: unknown): CodexPacket | null {
    const bytes = runtimeJsonBytes(value);
    const release = this.budget.reserve(4 * bytes + 256);
    if (!release) return null;
    try {
      return { data: Buffer.from(JSON.stringify(value)), binary: false, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  send(
    socket: WebSocket,
    packet: CodexPacket,
    failed: (error: Error) => void,
    pong = false,
  ): boolean {
    if (socket.readyState !== WebSocket.OPEN) {
      packet.release();
      return false;
    }
    let entries = this.pending.get(socket);
    if (!entries) {
      entries = new Set();
      this.pending.set(socket, entries);
      const held = entries;
      socket.once('close', () => {
        for (const release of held) release();
        held.clear();
        this.pending.delete(socket);
      });
    }
    const held = entries;
    let active = true;
    const complete = (error?: Error) => {
      if (active) {
        active = false;
        held.delete(release);
        packet.release();
      }
      if (error) failed(error);
    };
    const release = () => complete();
    held.add(release);
    try {
      if (pong) socket.pong(packet.data, undefined, complete);
      else socket.send(packet.data, { binary: packet.binary }, complete);
      return true;
    } catch (error) {
      complete(error instanceof Error ? error : new Error('Codex native send failed'));
      return false;
    }
  }
}
