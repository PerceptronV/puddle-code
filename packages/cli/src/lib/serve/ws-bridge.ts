import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { wsClientMessageSchema } from '@puddle/shared';
import type { ConnectionAuthority } from '../auth/connection-authority.js';
import type { BrowserAuthority, BrowserRecord } from './browser-authority.js';
import { openAccess } from './access.js';
import type { ProxyTarget } from './proxy.js';

/** Authenticates both legs; browser writes wait for an explicit upstream acknowledgement. */
export class WsBridge {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  constructor(
    private readonly browsers: BrowserAuthority,
    private readonly authority: ConnectionAuthority,
    private readonly target: ProxyTarget,
  ) {}
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (browser) => {
      let upstream: WebSocket | null = null;
      let resource: ReturnType<typeof openAccess> | null = null;
      let ready = false;
      let authorisation: BrowserRecord | null = null;
      const timer = setTimeout(
        () =>
          browser.close(
            authorisation ? 4410 : 4401,
            authorisation ? 'upstream_unavailable' : 'browser_rejected',
          ),
        5000,
      );
      const close = () => {
        ready = false;
        upstream?.terminate();
        browser.close(4410, 'upstream_unavailable');
      };
      browser.on('error', close);
      browser.on('close', () => {
        clearTimeout(timer);
        resource?.release();
        upstream?.terminate();
      });
      browser.on('message', (raw) => {
        const parsed = (() => {
          try {
            return wsClientMessageSchema.safeParse(JSON.parse(String(raw)));
          } catch {
            return null;
          }
        })();
        if (!parsed?.success) {
          browser.close(4400, 'malformed message');
          return;
        }
        const message = parsed.data;
        if (message.t === 'auth') {
          if (resource) {
            browser.close(4401, 'browser_rejected');
            return;
          }
          const record = this.browsers.authenticate(message.token);
          if (!record) {
            browser.close(4401, 'browser_rejected');
            return;
          }
          authorisation = record;
          if (this.authority.state !== 'ready') {
            browser.close(4410, this.authority.state);
            return;
          }
          try {
            resource = openAccess(
              { authority: this.authority, browsers: this.browsers, browser: record },
              close,
            );
          } catch {
            close();
            return;
          }
          const captured = resource;
          upstream = new WebSocket(`ws://${this.target.host}:${this.target.port}/ws`);
          upstream.on('error', close);
          upstream.on('close', close);
          upstream.on('open', () => {
            if (!captured.valid()) {
              close();
              return;
            }
            upstream?.send(
              JSON.stringify({ t: 'auth', token: captured.token, resource: captured.id }),
            );
          });
          upstream.on('message', (data) => {
            if (!captured.valid()) {
              close();
              return;
            }
            if (!ready) {
              try {
                if ((JSON.parse(String(data)) as { t?: string }).t !== 'authenticated') {
                  close();
                  return;
                }
              } catch {
                close();
                return;
              }
              clearTimeout(timer);
              ready = true;
            }
            if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: false });
          });
        } else {
          if (!ready || !resource?.valid() || upstream?.readyState !== WebSocket.OPEN) {
            close();
            return;
          }
          if (authorisation) this.browsers.touch(authorisation);
          upstream.send(JSON.stringify(message));
        }
      });
    });
  }
  close(): void {
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
