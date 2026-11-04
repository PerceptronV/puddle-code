import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';
import {
  guardCodexReceiver,
  type CodexReceiverFlow,
} from '../../../../src/agents/codex/lifecycle/receiver.js';
import { CodexSocketWrites } from '../../../../src/agents/codex/lifecycle/writes.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function pair(budget: RuntimeBufferBudget) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    autoPong: false,
    allowSynchronousEvents: true,
  });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Missing address');
  let flow!: CodexReceiverFlow;
  const incoming = new Promise<WebSocket>((resolve, reject) =>
    server.once('connection', (socket) => {
      socket.on('error', () => {});
      try {
        flow = guardCodexReceiver(socket, budget, () => socket.terminate());
        resolve(socket);
      } catch (error) {
        reject(error);
      }
    }),
  );
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
  client.on('error', () => {});
  const accepted = await incoming;
  await once(client, 'open');
  cleanup.push(async () => {
    client.terminate();
    accepted.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, accepted, flow };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

describe('Codex scoped native buffering', () => {
  it('retains fragmented raw input through the message callback and transfers downstream capacity', async () => {
    const parent = new RuntimeBufferBudget({ bytes: 100_000, count: 100 });
    const budget = new RuntimeBufferBudget({ bytes: 100_000, count: 100 }, parent);
    const { client, accepted } = await pair(budget);
    client.send('hello ', { fin: false });
    await vi.waitFor(() => expect(budget.usedBytes).toBeGreaterThan(0));
    const first = budget.usedBytes;
    let release: (() => void) | null = null;
    const delivered = new Promise<void>((resolve) =>
      accepted.once('message', (data) => {
        expect(String(data)).toBe('hello 世界');
        expect(budget.usedBytes).toBeGreaterThanOrEqual(first);
        release = parent.reserve(1000);
        expect(release).not.toBeNull();
        resolve();
      }),
    );
    client.send('世界', { fin: true });
    await delivered;
    expect(budget.usedBytes).toBe(0);
    expect(parent.usedBytes).toBe(1000);
    (release as unknown as () => void)();
    expect(parent.usedBytes).toBe(0);
  });

  it('pauses a denied raw chunk before parsing and delivers it once after shared credit returns', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 10000, count: 100 });
    const occupied = owner.reserve(10000)!;
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 100 }, owner);
    const { client, accepted } = await pair(budget);
    const messages = vi.fn();
    accepted.on('message', messages);
    client.send('wait for capacity');
    await tick();
    expect(messages).not.toHaveBeenCalled();
    expect(accepted.readyState).toBe(WebSocket.OPEN);
    expect(budget.usedBytes).toBe(0);
    occupied();
    await vi.waitFor(() => expect(messages).toHaveBeenCalledOnce());
    expect(String(messages.mock.calls[0]![0])).toBe('wait for capacity');
    expect(budget.usedBytes).toBe(0);
  });

  it('keeps concatenated fragmented payloads charged until the final message', async () => {
    const budget = new RuntimeBufferBudget({ bytes: 4 * 1024 * 1024, count: 100 });
    const { client, accepted } = await pair(budget);
    client.send('x'.repeat(200000), { fin: false });
    await vi.waitFor(() => {
      const receiver = (accepted as unknown as { _receiver: { _fragments: Buffer[] } })._receiver;
      expect(receiver._fragments.reduce((n, b) => n + b.length, 0)).toBe(200000);
    });
    expect(budget.usedBytes).toBeGreaterThanOrEqual(8 * 200000);
    const message = once(accepted, 'message');
    client.send('last', { fin: true });
    expect(String((await message)[0]).length).toBe(200004);
    expect(budget.usedBytes).toBe(0);
  });

  it('keeps an admitted fragment while later raw input waits and cleans up a paused close', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 10000, count: 100 });
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 100 }, owner);
    const { client, accepted } = await pair(budget);
    client.send('first-', { fin: false });
    await vi.waitFor(() => expect(budget.usedBytes).toBeGreaterThan(0));
    const occupied = owner.reserve(10000 - owner.usedBytes)!;
    const messages = vi.fn();
    accepted.on('message', messages);
    client.send('last', { fin: true });
    await tick();
    expect(messages).not.toHaveBeenCalled();
    expect(accepted.readyState).toBe(WebSocket.OPEN);
    occupied();
    await vi.waitFor(() => expect(messages).toHaveBeenCalledOnce());
    expect(String(messages.mock.calls[0]![0])).toBe('first-last');
    expect(owner.usedBytes).toBe(0);
    const held = owner.reserve(10000)!;
    client.send('paused');
    await tick();
    const closed = new Promise<void>((resolve) => accepted.once('close', () => resolve()));
    client.terminate();
    await closed;
    held();
    expect(budget.usedBytes).toBe(0);
  });

  it('stops coalesced same-chunk parsing and retains admitted bytes while an unsent message waits', async () => {
    const budget = new RuntimeBufferBudget({ bytes: 100000, count: 100 });
    const { client, accepted, flow } = await pair(budget);
    let ready = false;
    const delivered: string[] = [];
    accepted.on('message', (data) => {
      const text = String(data);
      const forward = () => {
        if (!ready) return false;
        delivered.push(text);
        return true;
      };
      if (!forward()) flow.defer(forward);
    });
    const stream = (client as unknown as { _socket: { cork(): void; uncork(): void } })._socket;
    stream.cork();
    client.send('first');
    client.send('second');
    stream.uncork();
    await tick();
    expect(delivered).toEqual([]);
    expect(budget.usedBytes).toBeGreaterThan(0);
    expect(accepted.readyState).toBe(WebSocket.OPEN);
    ready = true;
    await vi.waitFor(() => expect(delivered).toEqual(['first', 'second']));
    expect(budget.usedBytes).toBe(0);
  });

  it('reclaims consumed chunks when a continuous stream always ends mid-frame', async () => {
    // Use the pinned ws encoder, not a second WebSocket framing implementation.
    const { Sender } = createRequire(import.meta.url)('ws') as {
      Sender: { frame(data: Buffer, options: Record<string, unknown>): Buffer[] };
    };
    const budget = new RuntimeBufferBudget({ bytes: 5000, count: 10 });
    const { client, accepted } = await pair(budget);
    const stream = (client as unknown as { _socket: { write(data: Buffer): void } })._socket;
    const encode = (text: string) =>
      Buffer.concat(
        Sender.frame(Buffer.from(text), {
          fin: true,
          opcode: 1,
          mask: true,
          rsv1: false,
          readOnly: true,
        }),
      );
    let previous = encode('x'.repeat(100));
    const messages = vi.fn();
    accepted.on('message', messages);
    stream.write(previous.subarray(0, -1));
    for (let i = 0; i < 30; i++) {
      const next = encode('x'.repeat(100));
      stream.write(Buffer.concat([previous.subarray(-1), next.subarray(0, -1)]));
      await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(i + 1));
      expect(budget.usedBytes).toBeLessThan(3000);
      previous = next;
    }
    stream.write(previous.subarray(-1));
    await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(31));
    expect(budget.usedBytes).toBe(0);
  });

  it('transfers receive capacity through forwarding without requiring another shared grant', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 10000, count: 1 });
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 100 }, owner);
    const { client, accepted, flow } = await pair(budget);
    const sends = new CodexSocketWrites(new RuntimeBufferBudget({ bytes: 0, count: 0 }, owner));
    const downstream = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }) as unknown as WebSocket;
    const message = new Promise<void>((resolve) =>
      accepted.once('message', (data) => {
        const packet = sends.forward(data as Buffer, false, flow);
        expect(packet).not.toBeNull();
        sends.send(downstream, packet!, vi.fn());
        resolve();
      }),
    );
    client.send('already admitted');
    await message;
    expect(budget.usedBytes).toBeGreaterThan(0);
    expect(owner.usedCount).toBe(1);
    const callback = (downstream.send as ReturnType<typeof vi.fn>).mock.calls[0]![2] as () => void;
    callback();
    expect(budget.usedBytes).toBe(0);
    expect(owner.usedBytes).toBe(0);
  });

  it('retains partial frames until actual socket close and bounds explicit pongs', async () => {
    const budget = new RuntimeBufferBudget({ bytes: 10_000, count: 10 });
    const { client, accepted } = await pair(budget);
    const writes = new CodexSocketWrites(budget);
    accepted.on('ping', (data) => {
      const packet = writes.pong(data);
      expect(packet).not.toBeNull();
      writes.send(accepted, packet!, () => {}, true);
    });
    const pong = once(client, 'pong');
    client.ping('heartbeat');
    expect(String((await pong)[0])).toBe('heartbeat');
    await tick();
    expect(budget.usedBytes).toBe(0);
    client.send('partial', { fin: false });
    await vi.waitFor(() => expect(budget.usedBytes).toBeGreaterThan(0));
    const closed = new Promise<void>((resolve) => accepted.once('close', () => resolve()));
    client.terminate();
    await closed;
    expect(budget.usedBytes).toBe(0);
  });

  it('pays for pending pong copies without retaining fragmented-message reference sets', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 4 * 1024 * 1024, count: 10000 });
    const receive = new RuntimeBufferBudget({ bytes: 4 * 1024 * 1024, count: 1000 }, owner);
    const { client, accepted, flow } = await pair(receive);
    const retain = vi.spyOn(flow, 'retain');
    const sendBudget = new RuntimeBufferBudget({ bytes: 1024 * 1024, count: 1024 }, owner);
    const writes = new CodexSocketWrites(sendBudget);
    const downstream = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      pong: vi.fn(),
    }) as unknown as WebSocket;
    accepted.on('ping', (data) => {
      const packet = writes.pong(data);
      expect(packet).not.toBeNull();
      writes.send(downstream, packet!, vi.fn(), true);
    });
    client.send('x'.repeat(200000), { fin: false });
    await vi.waitFor(() => expect(receive.usedBytes).toBeGreaterThanOrEqual(1600000));
    for (let i = 0; i < 100; i++) client.ping('heartbeat');
    await vi.waitFor(() => expect(downstream.pong).toHaveBeenCalledTimes(100));
    expect(retain).not.toHaveBeenCalled();
    expect(sendBudget.usedCount).toBe(100);
    downstream.emit('close');
    expect(sendBudget.usedBytes).toBe(0);
    const message = once(accepted, 'message');
    client.send('end', { fin: true });
    await message;
    expect(owner.usedBytes).toBe(0);
  });

  it('holds queued sends through callback or close and refuses allocation before Buffer.from', () => {
    const budget = new RuntimeBufferBudget({ bytes: 1024, count: 1 });
    const writes = new CodexSocketWrites(budget);
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    }) as unknown as WebSocket;
    const packet = writes.json({ text: 'queued' })!;
    expect(writes.send(socket, packet, vi.fn())).toBe(true);
    const from = vi.spyOn(Buffer, 'from');
    expect(writes.json({ text: 'next' })).toBeNull();
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
    socket.emit('close');
    expect(budget.usedBytes).toBe(0);
    const callback = (socket.send as ReturnType<typeof vi.fn>).mock.calls[0]![2] as () => void;
    callback();
    expect(budget.usedBytes).toBe(0);
    expect(writes.json({ text: 'later' })).not.toBeNull();
  });
});
