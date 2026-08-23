import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { LifecycleLaunchContext, LifecycleLaunchResource } from './adapter.js';

interface PendingRequest {
  method: 'thread/start' | 'thread/resume' | 'thread/fork';
  cwd: string;
  parentRef?: string;
  requestedRef?: string;
  ephemeral: boolean;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

/**
 * Daemon-owned Codex app-server proxy. Verified against codex-cli 0.147.0:
 * `codex --remote ws://…` uses JSON-RPC thread/start, thread/resume and
 * thread/fork; successful responses carry the exact thread id. Reviews and
 * side threads are ignored through the app-server's `ephemeral` bit.
 */
export async function prepareCodexLifecycle(
  context: LifecycleLaunchContext,
): Promise<LifecycleLaunchResource> {
  const appPort = await freePort();
  const appUrl = `ws://127.0.0.1:${appPort}`;
  const appServer = spawn(
    'codex',
    ['app-server', '--listen', appUrl],
    codexAppServerSpawnOptions(context),
  );
  let errorTail = '';
  appServer.once('error', (error) => {
    errorTail = `${errorTail}${error.message}`.slice(-2_000);
  });
  appServer.stderr?.on('data', (chunk: Buffer | string) => {
    errorTail = `${errorTail}${String(chunk)}`.slice(-2_000);
  });
  try {
    await waitForWebSocket(appUrl, appServer, () => errorTail);
  } catch (error) {
    stopProcess(appServer);
    throw error;
  }

  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('listening', resolve);
      proxy.once('error', reject);
    });
  } catch (error) {
    proxy.close();
    stopProcess(appServer);
    throw error;
  }
  const address = proxy.address();
  if (address === null || typeof address === 'string') {
    proxy.close();
    stopProcess(appServer);
    throw new Error('Codex lifecycle proxy did not bind a TCP port');
  }
  const proxyPort = address.port;
  const sockets = new Set<WebSocket>();
  proxy.on('connection', (client) => {
    sockets.add(client);
    const upstream = new WebSocket(appUrl);
    sockets.add(upstream);
    const queue: Array<{ data: Buffer; binary: boolean }> = [];
    const pending = new Map<string, PendingRequest>();
    const state: { activeRef: string | null } = { activeRef: null };

    client.on('message', (data, binary) => {
      inspectRequest(data, pending, context.opts.worktreePath);
      const packet = { data: rawBuffer(data), binary };
      if (upstream.readyState === WebSocket.OPEN) upstream.send(packet.data, { binary });
      else queue.push(packet);
    });
    upstream.on('open', () => {
      for (const packet of queue) upstream.send(packet.data, { binary: packet.binary });
      queue.length = 0;
    });
    upstream.on('message', (data, binary) => {
      inspectResponse(data, pending, context, state);
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    const closePair = () => {
      if (client.readyState < WebSocket.CLOSING) client.close();
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    };
    client.on('close', closePair);
    upstream.on('close', closePair);
    client.on('error', closePair);
    upstream.on('error', closePair);
    client.once('close', () => sockets.delete(client));
    upstream.once('close', () => sockets.delete(upstream));
  });

  return {
    // Remote mode delegates workspace creation to app-server. Keep `-C`
    // explicit as well as setting the sidecar cwd below: either endpoint may
    // otherwise fall back to the daemon's directory when a protocol request
    // omits cwd, which makes Codex show `~` and loses the Git branch footer.
    args: codexRemoteArgs(`ws://127.0.0.1:${proxyPort}`, context),
    ...(appServer.pid !== undefined ? { sidecarPids: [appServer.pid] } : {}),
    hiddenPorts: [appPort, proxyPort],
    dispose: () => {
      for (const socket of sockets) socket.terminate();
      proxy.close();
      stopProcess(appServer);
    },
  };
}

export function codexRemoteArgs(
  remoteUrl: string,
  context: Pick<LifecycleLaunchContext, 'args' | 'opts'>,
): string[] {
  return ['--remote', remoteUrl, '-C', context.opts.worktreePath, ...context.args];
}

/** Load-bearing spawn context for the remote Codex workspace. */
export function codexAppServerSpawnOptions(
  context: Pick<LifecycleLaunchContext, 'account' | 'opts'>,
): SpawnOptions {
  return {
    cwd: context.opts.worktreePath,
    env: { ...process.env, CODEX_HOME: context.account.config_dir },
    stdio: ['ignore', 'ignore', 'pipe'],
  };
}

function inspectRequest(
  data: RawData,
  pending: Map<string, PendingRequest>,
  defaultCwd: string,
): void {
  for (const message of parseMessages(data)) {
    if (
      message.id === undefined ||
      !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method ?? '')
    ) {
      continue;
    }
    const params = message.params ?? {};
    const method = message.method as PendingRequest['method'];
    pending.set(String(message.id), {
      method,
      cwd: typeof params['cwd'] === 'string' ? params['cwd'] : defaultCwd,
      ...(typeof params['threadId'] === 'string'
        ? method === 'thread/fork'
          ? { parentRef: params['threadId'] }
          : { requestedRef: params['threadId'] }
        : {}),
      ephemeral: params['ephemeral'] === true,
    });
  }
}

function inspectResponse(
  data: RawData,
  pending: Map<string, PendingRequest>,
  context: LifecycleLaunchContext,
  state: { activeRef: string | null },
): void {
  for (const message of parseMessages(data)) {
    if (message.id === undefined) continue;
    const request = pending.get(String(message.id));
    if (!request) continue;
    pending.delete(String(message.id));
    if (message.error !== undefined || request.ephemeral) continue;
    const thread = message.result?.['thread'];
    const record = thread && typeof thread === 'object' ? (thread as Record<string, unknown>) : {};
    if (record['ephemeral'] === true) continue;
    const ref = typeof record['id'] === 'string' ? record['id'] : request.requestedRef;
    if (!ref) continue;
    const source =
      request.method === 'thread/fork'
        ? 'fork'
        : request.method === 'thread/resume'
          ? 'resume'
          : state.activeRef === null
            ? 'startup'
            : 'clear';
    state.activeRef = ref;
    void postLifecycle(context, {
      ref,
      cwd: request.cwd,
      source,
      ...(request.parentRef !== undefined ? { parentRef: request.parentRef } : {}),
    });
  }
}

async function postLifecycle(
  context: LifecycleLaunchContext,
  event: {
    ref: string;
    cwd: string;
    source: 'startup' | 'clear' | 'resume' | 'fork';
    parentRef?: string;
  },
): Promise<void> {
  try {
    await fetch(context.signalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: context.signalNonce,
        event: 'session_start',
        agent_session_ref: event.ref,
        cwd: event.cwd,
        source: event.source,
        ...(event.parentRef !== undefined ? { parent_agent_session_ref: event.parentRef } : {}),
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // A bridge signal must never interrupt the native protocol stream.
  }
}

function parseMessages(data: RawData): JsonRpcMessage[] {
  try {
    const parsed = JSON.parse(rawBuffer(data).toString('utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : isRecord(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isRecord(value: unknown): value is JsonRpcMessage {
  return value !== null && typeof value === 'object';
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForWebSocket(
  url: string,
  process: ChildProcess,
  errorText: () => string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (process.exitCode !== null) {
      throw new Error(
        `Codex app-server exited before ready: ${errorText().trim() || process.exitCode}`,
      );
    }
    const ready = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(false);
      }, 250);
      socket.once('open', () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (ready) return;
    if (Date.now() >= deadline) {
      throw new Error(`Codex app-server did not become ready: ${errorText().trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function stopProcess(process: ChildProcess): void {
  if (process.exitCode === null && !process.killed) process.kill('SIGTERM');
}
