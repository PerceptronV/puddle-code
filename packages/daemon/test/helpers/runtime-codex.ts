import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

// Deterministic native-transport fixture; never invokes an installed Codex CLI.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.159.0');
} else if (args[0] === 'app-server') {
  const port = Number(new URL(args[args.indexOf('--listen') + 1]!).port);
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  let count = 0;
  let bursts = 0;
  // Exercise the adapter's forced-exit fallback as well as awaited reaping.
  process.on('SIGTERM', () => {});
  server.on('connection', (socket) =>
    socket.on('message', async (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string };
      if (message.method === 'test/burst') {
        writeFileSync(join(process.cwd(), '.fake-codex-burst'), String(++bursts));
        const deadline = Date.now() + 15000;
        while (!existsSync(join(process.cwd(), '.fake-codex-release-burst'))) {
          if (Date.now() > deadline) throw new Error('Fake burst release timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      socket.send(
        JSON.stringify({
          id: message.id,
          result:
            message.method === 'thread/start'
              ? { thread: { id: 'native-codex-fixture' } }
              : message.method === 'test/burst'
                ? { burst: bursts, padding: 'x'.repeat(2 * 1024 * 1024) }
                : { count: ++count, pid: process.pid },
        }),
      );
    }),
  );
} else {
  const socket = new WebSocket(args[args.indexOf('--remote') + 1]!);
  let id = 1;
  socket.on('open', () =>
    socket.send(
      JSON.stringify({ id: id++, method: 'thread/start', params: { cwd: process.cwd() } }),
    ),
  );
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as {
      result?: {
        count?: number;
        pid?: number;
        thread?: { id: string };
        burst?: number;
        padding?: string;
      };
    };
    if (message.result?.thread) console.log(`bound:${message.result.thread.id}`);
    else if (message.result?.burst) {
      writeFileSync(join(process.cwd(), '.fake-codex-received'), String(message.result.burst));
      console.log(`burst:${message.result.burst} bytes:${message.result.padding?.length}`);
    } else console.log(`count:${message.result?.count} sidecar:${message.result?.pid}`);
  });
  process.stdin.on('data', (data) => {
    const text = String(data);
    const count = text.includes('many') ? 1100 : 1;
    for (let i = 0; i < count; i++)
      socket.send(
        JSON.stringify({ id: id++, method: text.includes('burst') ? 'test/burst' : 'test/tick' }),
      );
  });
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
}
