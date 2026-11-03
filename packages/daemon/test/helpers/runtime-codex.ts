import { WebSocket, WebSocketServer } from 'ws';

// Deterministic native-transport fixture; never invokes an installed Codex CLI.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.159.0');
} else if (args[0] === 'app-server') {
  const port = Number(new URL(args[args.indexOf('--listen') + 1]!).port);
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  let count = 0;
  // Exercise the adapter's forced-exit fallback as well as awaited reaping.
  process.on('SIGTERM', () => {});
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string };
      socket.send(
        JSON.stringify({
          id: message.id,
          result:
            message.method === 'thread/start'
              ? { thread: { id: 'native-codex-fixture' } }
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
      result?: { count?: number; pid?: number; thread?: { id: string } };
    };
    if (message.result?.thread) console.log(`bound:${message.result.thread.id}`);
    else console.log(`count:${message.result?.count} sidecar:${message.result?.pid}`);
  });
  process.stdin.on('data', () => socket.send(JSON.stringify({ id: id++, method: 'test/tick' })));
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
}
