import WebSocket from 'ws';
import type { WsServerMessage } from '@puddle/shared';
import { CliError } from './types.js';

export interface GatewayClient {
  send(message: Record<string, unknown>): void;
  onMessage(cb: (message: WsServerMessage) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * Minimal typed client for the daemon's /ws gateway. Auth is the mandatory
 * first message (browsers cannot set WS headers, so the daemon expects it
 * in-band from every client).
 */
export function connectGateway(port: number, token: string): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { host: `localhost:${port}` },
    });
    const messageCbs = new Set<(m: WsServerMessage) => void>();
    const closeCbs = new Set<() => void>();

    ws.once('error', (err) =>
      reject(new CliError('daemon_unreachable', `WebSocket connection failed: ${err.message}`)),
    );
    ws.on('message', (data) => {
      let parsed: WsServerMessage;
      try {
        parsed = JSON.parse(String(data)) as WsServerMessage;
      } catch {
        return; // tolerate unknown/garbled frames per the wire rules
      }
      messageCbs.forEach((cb) => cb(parsed));
    });
    ws.on('close', () => closeCbs.forEach((cb) => cb()));

    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token }));
      resolve({
        send(message) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        onMessage(cb) {
          messageCbs.add(cb);
        },
        onClose(cb) {
          closeCbs.add(cb);
        },
        close() {
          ws.close();
        },
      });
    });
  });
}
