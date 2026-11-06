import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { LifecycleLaunchContext, LifecycleLaunchResource } from '../adapter.js';
import { CodexControl } from './control.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { CodexBridgeBudgets, CODEX_BRIDGE_LIMITS } from './lifecycle/limits.js';
import { guardCodexReceiver, type CodexReceiverFlow } from './lifecycle/receiver.js';
import { CodexSocketWrites, type CodexPacket } from './lifecycle/writes.js';
import { CodexMessageInspection } from './lifecycle/messages.js';
import { CodexSignalQueue } from './lifecycle/signals.js';
import {
  clearPending,
  inspectRequest,
  inspectMessages,
  rawBuffer,
  type PendingRequest,
  type CodexSignalState,
} from './lifecycle/observations.js';

/**
 * Runtime-owned Codex app-server proxy. Verified against codex-cli 0.147.0:
 * `codex --remote ws://…` uses JSON-RPC thread/start, thread/resume and
 * thread/fork; successful responses carry the exact thread id. Reviews and
 * side threads are ignored through the app-server's `ephemeral` bit.
 */
export async function prepareCodexLifecycle(
  context: LifecycleLaunchContext,
): Promise<LifecycleLaunchResource> {
  // Exact turn injection/outputSchema verified against codex-cli 0.159.0.
  const scriptedTurns = await lifecycleVersionAtLeast(
    'codex',
    ['--version'],
    [0, 159, 0],
    context.env,
  );
  // 0.166.0's unsubscribe retains an idle thread/writer for 60 seconds by
  // default. Puddle moves the runtime to the fork and lets another runtime
  // resume the original; keep no idle native ownership after the TUI leaves.
  // Native busy threads remain loaded until their work actually ends.
  const immediateUnload = await lifecycleVersionAtLeast(
    'codex',
    ['--version'],
    [0, 166, 0],
    context.env,
  );
  const unloadArgs = immediateUnload ? ['-c', 'thread_unload_delay_secs=0'] : [];
  const appPort = await freePort();
  const appUrl = `ws://127.0.0.1:${appPort}`;
  const appServer = spawn(
    'codex',
    ['app-server', '--listen', appUrl, ...unloadArgs],
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
    await stopProcess(appServer);
    throw error;
  }

  const budgets = new CodexBridgeBudgets(context.bufferAllowance);
  const writes = new CodexSocketWrites(budgets.send);
  const proxy = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    autoPong: false,
    allowSynchronousEvents: true,
    maxPayload: CODEX_BRIDGE_LIMITS.payloadBytes,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('listening', resolve);
      proxy.once('error', reject);
    });
  } catch (error) {
    proxy.close();
    await stopProcess(appServer);
    throw error;
  }
  const address = proxy.address();
  if (address === null || typeof address === 'string') {
    proxy.close();
    await stopProcess(appServer);
    throw new Error('Codex lifecycle proxy did not bind a TCP port');
  }
  const proxyPort = address.port;
  const sockets = new Set<WebSocket>();
  const control = new CodexControl(context.bufferAllowance);
  let owner: WebSocket | null = null;
  let disposed = false;
  const deliveries = new Set<CodexSignalQueue>();
  proxy.on('connection', (client) => {
    if (owner && owner.readyState < WebSocket.CLOSING) {
      client.terminate();
      return;
    }
    owner = client;
    sockets.add(client);
    const upstream = new WebSocket(appUrl, {
      perMessageDeflate: false,
      autoPong: false,
      allowSynchronousEvents: true,
      maxPayload: CODEX_BRIDGE_LIMITS.payloadBytes,
    });
    sockets.add(upstream);
    const queue: CodexPacket[] = [];
    const pending = new Map<string, PendingRequest>();
    const inspections = new Set<CodexMessageInspection>();
    const delivery = new CodexSignalQueue(
      {
        ...context,
        reportLifecycleUnavailable: () => {
          // An outstanding scripted turn cannot outlive uncertain native identity.
          control.disconnect();
          context.reportLifecycleUnavailable?.();
        },
      },
      budgets.signals,
    );
    deliveries.add(delivery);
    const state: CodexSignalState = { activeRef: null, queue: Promise.resolve(), delivery };
    let closing = false;
    const closePair = () => {
      if (closing) return;
      closing = true;
      if (!disposed) context.reportLifecycleUnavailable?.();
      if (owner === client) {
        owner = null;
        control.disconnect();
      }
      clearPending(pending);
      for (const inspection of inspections) inspection.close();
      inspections.clear();
      for (const packet of queue.splice(0)) packet.release();
      void delivery.close().finally(() => deliveries.delete(delivery));
      client.terminate();
      upstream.terminate();
    };
    let clientFlow: CodexReceiverFlow;
    let upstreamFlow: CodexReceiverFlow;
    const heartbeat = (socket: WebSocket, data: Buffer, flow: CodexReceiverFlow) => {
      const send = (payload: Buffer) => {
        const packet = writes.pong(payload);
        if (!packet) return false;
        if (!writes.send(socket, packet, closePair, true)) closePair();
        return true;
      };
      if (!send(data)) {
        // One <=125-byte essential pending control copy per paused leg. Pongs
        // must not snapshot thousands of unrelated fragmented-message records.
        const pending = Buffer.from(data);
        flow.defer(() => send(pending), false);
      }
    };
    client.on('close', closePair);
    upstream.on('close', closePair);
    client.on('error', closePair);
    upstream.on('error', closePair);
    client.once('close', () => sockets.delete(client));
    upstream.once('close', () => sockets.delete(upstream));
    client.on('ping', (data) => heartbeat(client, data, clientFlow));
    upstream.on('ping', (data) => heartbeat(upstream, data, upstreamFlow));
    try {
      clientFlow = guardCodexReceiver(client, budgets.receive, closePair);
    } catch {
      closePair();
      return;
    }

    client.on('message', (data, binary) => {
      if (owner !== client || closing) return;
      try {
        const body = rawBuffer(data);
        const inspection = new CodexMessageInspection(body, budgets.metadata);
        inspections.add(inspection);
        const forward = () => {
          if (closing || owner !== client) return true;
          const messages = inspection.read();
          if (messages === null) return false;
          const packet = writes.forward(body, binary, clientFlow);
          if (!packet) return false;
          try {
            if (!inspectRequest(messages, pending, context.opts.worktreePath, budgets.pending)) {
              packet.release();
              return false;
            }
            for (const message of messages) control.client(message as Record<string, unknown>);
            if (upstream.readyState === WebSocket.OPEN) {
              if (!writes.send(upstream, packet, closePair)) closePair();
            } else queue.push(packet);
            inspection.close();
            inspections.delete(inspection);
            return true;
          } catch (error) {
            packet.release();
            throw error;
          }
        };
        if (!forward()) clientFlow.defer(forward);
      } catch {
        closePair();
      }
    });
    upstream.on('open', () => {
      if (owner !== client || closing) {
        closePair();
        return;
      }
      try {
        upstreamFlow = guardCodexReceiver(upstream, budgets.receive, closePair);
      } catch {
        closePair();
        return;
      }
      control.connect((message) => {
        const packet = writes.json(message);
        if (!packet) throw new Error('Codex native send capacity exhausted before dispatch');
        if (!writes.send(upstream, packet, closePair)) throw new Error('Codex native send failed');
      });
      for (const packet of queue.splice(0))
        if (!writes.send(upstream, packet, closePair)) closePair();
    });
    upstream.on('message', (data, binary) => {
      if (owner !== client || closing) return;
      try {
        const raw = rawBuffer(data);
        const inspection = new CodexMessageInspection(raw, budgets.metadata);
        inspections.add(inspection);
        const forward = () => {
          if (closing || owner !== client) return true;
          const messages = inspection.read();
          if (messages === null) return false;
          const visible = messages.filter(
            (message) => !(typeof message.id === 'string' && message.id.startsWith('puddlang:')),
          );
          const filtered = visible.length !== messages.length;
          // Strings/forwarding copies remain covered by admitted receive bytes.
          const body = filtered
            ? visible.length
              ? Buffer.from(JSON.stringify(visible.length === 1 ? visible[0] : visible))
              : null
            : raw;
          const packet = body
            ? writes.forward(body, filtered ? false : binary, upstreamFlow)
            : null;
          if (body && !packet) return false;
          try {
            if (!inspectMessages(messages, pending, context, state)) {
              packet?.release();
              return false;
            }
            if (state.activeRef) control.bind(state.activeRef);
            for (const message of messages) control.server(message as Record<string, unknown>);
            if (packet && !writes.send(client, packet, closePair)) closePair();
            inspection.close();
            inspections.delete(inspection);
            return true;
          } catch (error) {
            packet?.release();
            throw error;
          }
        };
        if (!forward()) upstreamFlow.defer(forward);
      } catch {
        closePair();
      }
    });
  });

  return {
    ...(scriptedTurns ? { control } : {}),
    // Remote mode delegates workspace creation to app-server. Keep `-C`
    // explicit as well as setting the sidecar cwd below: either endpoint may
    // otherwise fall back to the daemon's directory when a protocol request
    // omits cwd, which makes Codex show `~` and loses the Git branch footer.
    args: codexRemoteArgs(`ws://127.0.0.1:${proxyPort}`, context, unloadArgs),
    ...(appServer.pid !== undefined ? { sidecarPids: [appServer.pid] } : {}),
    hiddenPorts: [appPort, proxyPort],
    dispose: async () => {
      disposed = true;
      control.disconnect();
      for (const socket of sockets) socket.terminate();
      await Promise.all([...deliveries].map((delivery) => delivery.close()));
      proxy.close();
      await stopProcess(appServer);
    },
  };
}

export function codexRemoteArgs(
  remoteUrl: string,
  context: Pick<LifecycleLaunchContext, 'args' | 'opts'>,
  unloadArgs: readonly string[] = [],
): string[] {
  return ['--remote', remoteUrl, '-C', context.opts.worktreePath, ...unloadArgs, ...context.args];
}

/** Load-bearing spawn context for the remote Codex workspace. */
export function codexAppServerSpawnOptions(
  context: Pick<LifecycleLaunchContext, 'account' | 'opts' | 'env'>,
): SpawnOptions {
  return {
    cwd: context.opts.worktreePath,
    env: { ...process.env, ...context.env, CODEX_HOME: context.account.config_dir },
    stdio: ['ignore', 'ignore', 'pipe'],
  };
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
      const socket = new WebSocket(url, { perMessageDeflate: false });
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

async function stopProcess(process: ChildProcess): Promise<void> {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const force = setTimeout(() => process.kill('SIGKILL'), 1500);
  try {
    // The runtime must not release conversation ownership while its app-server
    // is still executing tools. Sending a signal alone does not establish exit.
    await exited;
  } finally {
    clearTimeout(force);
  }
}
