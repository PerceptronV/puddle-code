import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { Transform } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { terminalCompression } from '../../src/ws/compression.js';

// Deterministic ANSI redraws, including Unicode and changing source lines.
const redraw = Array.from(
  { length: 300 },
  (_, i) =>
    `\x1b[${(i % 30) + 1};1H\x1b[32m${i}: export const item${i} = "✓ network fixture ${i * 7919}";\x1b[0m\r\n`,
).join('');
const payload = JSON.stringify({ t: 'output', session: 'fixture', term: 'agent', data: redraw });

async function transfer(compression: boolean, bitsPerSecond?: number) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    perMessageDeflate: terminalCompression,
  });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const sockets = new Set<Socket>();
  const proxy = bitsPerSecond
    ? createServer((downstream) => {
        const upstream = connect(address.port, '127.0.0.1');
        sockets.add(downstream);
        sockets.add(upstream);
        const close = () => {
          downstream.destroy();
          upstream.destroy();
        };
        downstream.on('error', close).on('close', close);
        upstream.on('error', close);
        downstream.pipe(upstream);
        upstream
          .pipe(
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                setTimeout(() => callback(null, chunk), (chunk.length * 8 * 1000) / bitsPerSecond);
              },
            }),
          )
          .pipe(downstream);
      })
    : null;
  if (proxy) {
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
  }
  const port = (proxy?.address() as { port: number } | undefined)?.port ?? address.port;
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${port}`, {
    perMessageDeflate: compression,
  });
  try {
    const [peer, request] = (await connected) as [WebSocket, { socket: Socket }];
    await once(client, 'open');
    const before = request.socket.bytesWritten;
    const received = once(client, 'message');
    const started = performance.now();
    peer.send(payload);
    const [data] = (await received) as [Buffer];
    expect(data.toString()).toBe(payload);
    return {
      bytes: request.socket.bytesWritten - before,
      extension: client.extensions,
      ms: performance.now() - started,
    };
  } finally {
    client.terminate();
    for (const peer of server.clients) peer.terminate();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('negotiates terminal compression without changing messages or requiring a new client', async () => {
  const plain = await transfer(false);
  const compressed = await transfer(true);
  expect(plain.extension).toBe('');
  expect(compressed.extension).toBe('permessage-deflate');
  expect(compressed.bytes).toBeLessThan(plain.bytes / 3);
  console.info(`Terminal fixture wire bytes: ${plain.bytes} plain; ${compressed.bytes} compressed`);
});

it.each([64_000, 512_000, 10_000_000])(
  'delivers exact terminal output through a %i bit/s bottleneck',
  async (rate) => {
    const plain = await transfer(false, rate);
    const compressed = await transfer(true, rate);
    expect(compressed.bytes).toBeLessThan(plain.bytes / 3);
    if (rate === 64_000) expect(compressed.ms).toBeLessThan(plain.ms / 2);
    console.info(
      `${rate} bit/s: ${plain.bytes} → ${compressed.bytes} bytes; ${plain.ms.toFixed(0)} → ${compressed.ms.toFixed(0)} ms`,
    );
  },
);
