import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { fromNodeHeaders } from 'better-auth/node';
import WebSocket, { WebSocketServer } from 'ws';
import { REMOTE_POLICY, remoteConnectSchema, remoteIdSchema } from '@puddle/shared';
import type { ServiceStore } from './store.js';
import type { ServiceAuth } from './auth.js';
import type { RemoteConfig } from './config.js';
import { RateLimit } from './rate-limit.js';

interface Pipe {
  id: string;
  host: string;
  account: string;
  headers: Headers;
  browser: WebSocket;
  connector?: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

/** An opaque, bounded byte splice. No encryption keys or application parsing live here. */
export class Relay {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_POLICY.frameBytes,
    perMessageDeflate: false,
  });
  private readonly connectors = new Map<string, WebSocket>();
  private readonly pipes = new Map<string, Pipe>();
  private readonly rate = new RateLimit(60);
  private readonly accountRate = new RateLimit(30);
  private readonly lastPong = new Map<WebSocket, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private checking = false;
  constructor(
    server: Server,
    private readonly config: RemoteConfig,
    private readonly auth: ServiceAuth,
    private readonly store: ServiceStore,
  ) {
    server.on('upgrade', (req, socket, head) => {
      void this.upgrade(req, socket, head).catch(() => socket.destroy());
    });
    this.timer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (Date.now() - (this.lastPong.get(socket) ?? 0) >= 45_000) socket.terminate();
        else socket.ping();
      }
      void this.recheck();
    }, 15_000);
  }
  online(host: string): boolean {
    return this.connectors.get(host)?.readyState === WebSocket.OPEN;
  }
  remove(host: string): void {
    this.connectors.get(host)?.terminate();
    for (const pipe of this.pipes.values()) if (pipe.host === host) this.drop(pipe);
  }
  private drop(pipe: Pipe): void {
    this.pipes.delete(pipe.id);
    clearTimeout(pipe.timer);
    pipe.browser.terminate();
    pipe.connector?.terminate();
  }
  async recheck(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const pipe of this.pipes.values()) {
        const current = await this.auth.authorised(pipe.headers).catch(() => null);
        if (
          !current ||
          current.user.id !== pipe.account ||
          this.store.host(pipe.host)?.account !== pipe.account
        )
          this.drop(pipe);
      }
    } finally {
      this.checking = false;
    }
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = req.url;
    if (
      req.headers.host !== new URL(this.config.service).host ||
      !this.rate.take(req.socket.remoteAddress ?? '') ||
      this.server.clients.size >= REMOTE_POLICY.connections * 3
    )
      return void socket.destroy();
    if (path === '/remote/browser') {
      if (req.headers.origin !== this.config.app) return void socket.destroy();
      const headers = fromNodeHeaders(req.headers);
      const current = await this.auth.authorised(headers);
      if (!current || !this.accountRate.take(current.user.id)) return void socket.destroy();
      this.accept(req, socket, head, (browser) => {
        const firstTimer = setTimeout(() => browser.terminate(), REMOTE_POLICY.handshakeMs);
        browser.once('close', () => clearTimeout(firstTimer));
        browser.once('message', (raw, binary) => {
          clearTimeout(firstTimer);
          try {
            if (binary || String(raw).length > 4096) return browser.terminate();
            const message = remoteConnectSchema.parse(JSON.parse(String(raw)));
            const host = this.store.host(message.host);
            if (
              !host ||
              host.account !== current.user.id ||
              !this.online(host.id) ||
              this.pipes.size >= REMOTE_POLICY.connections ||
              [...this.pipes.values()].filter((p) => p.host === host.id).length >=
                REMOTE_POLICY.connectionsPerHost ||
              [...this.pipes.values()].filter((p) => p.account === host.account).length >=
                REMOTE_POLICY.connectionsPerAccount
            )
              return browser.terminate();
            const id = randomUUID();
            const pipe: Pipe = {
              id,
              host: host.id,
              account: host.account,
              headers,
              browser,
              timer: setTimeout(() => this.drop(pipe), REMOTE_POLICY.handshakeMs),
            };
            this.pipes.set(id, pipe);
            browser.on('close', () => this.drop(pipe));
            browser.on('message', (data, isBinary) =>
              this.forward(pipe, pipe.connector, data, isBinary),
            );
            this.connectors
              .get(host.id)!
              .send(JSON.stringify({ t: 'open', connection: id, account: host.account }));
          } catch {
            browser.terminate();
          }
        });
      });
    } else if (path === '/remote/connector' || path === '/remote/pipe') {
      // These endpoints are machine-only. Browser credentials and origins never admit them.
      if (req.headers.origin !== undefined) return void socket.destroy();
      const credential = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const host = this.store.authenticate(credential);
      if (!host) return void socket.destroy();
      if (path === '/remote/connector') {
        if (this.connectors.has(host.id)) return void socket.destroy();
        this.accept(req, socket, head, (connector) => {
          this.connectors.set(host.id, connector);
          connector.send(JSON.stringify({ t: 'registered', host: host.id }));
          connector.on('message', () => connector.terminate());
          connector.on('close', () => {
            if (this.connectors.get(host.id) !== connector) return;
            this.connectors.delete(host.id);
            for (const pipe of this.pipes.values()) if (pipe.host === host.id) this.drop(pipe);
          });
        });
      } else {
        const parsed = remoteIdSchema.safeParse(req.headers['x-puddle-pipe']);
        const pipe = parsed.success ? this.pipes.get(parsed.data) : undefined;
        if (
          !pipe ||
          pipe.host !== host.id ||
          pipe.account !== host.account ||
          pipe.connector ||
          !this.online(host.id)
        )
          return void socket.destroy();
        this.accept(req, socket, head, (connector) => {
          pipe.connector = connector;
          clearTimeout(pipe.timer);
          connector.on('message', (data, binary) => this.forward(pipe, pipe.browser, data, binary));
          connector.on('close', () => this.drop(pipe));
          pipe.browser.send(
            JSON.stringify({ t: 'ready', connection: pipe.id, account: pipe.account }),
          );
        });
      }
    } else socket.destroy();
  }
  private accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    accepted: (socket: WebSocket) => void,
  ): void {
    this.server.handleUpgrade(req, socket, head, (ws) => {
      this.lastPong.set(ws, Date.now());
      ws.on('pong', () => this.lastPong.set(ws, Date.now()));
      ws.on('error', () => ws.terminate());
      ws.on('close', () => this.lastPong.delete(ws));
      accepted(ws);
    });
  }
  private forward(
    pipe: Pipe,
    target: WebSocket | undefined,
    data: WebSocket.RawData,
    binary: boolean,
  ): void {
    if (!this.pipes.has(pipe.id)) return;
    const size = Array.isArray(data)
      ? data.reduce((n, part) => n + part.length, 0)
      : data.byteLength;
    if (
      !binary ||
      !target ||
      target.readyState !== WebSocket.OPEN ||
      size > REMOTE_POLICY.frameBytes ||
      target.bufferedAmount + size > REMOTE_POLICY.queueBytes ||
      [...this.server.clients].reduce((n, socket) => n + socket.bufferedAmount, size) >
        REMOTE_POLICY.relayQueueBytes
    )
      return this.drop(pipe);
    target.send(data, { binary: true }, (error) => {
      if (error) this.drop(pipe);
    });
  }
  close(): void {
    clearInterval(this.timer);
    for (const socket of this.server.clients) socket.terminate();
    this.server.close();
  }
}
