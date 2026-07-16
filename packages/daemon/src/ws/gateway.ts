import { timingSafeEqual } from 'node:crypto';
import type { WSContext } from 'hono/ws';
import { wsClientMessageSchema, type WsServerMessage } from '@puddle/shared';
import type { LogStore } from '../logs/log-store.js';
import type { PtyDataEvent, PtyExitEvent, PtyManager } from '../pty/pty-manager.js';
import type { RenameEvent, SessionService, StatusEvent } from '../sessions/service.js';
import { ApiError } from '../http/errors.js';

export interface WsGatewayDeps {
  token: string;
  ptys: PtyManager;
  logs: LogStore;
  service: SessionService;
}

interface WsEventHandlers {
  onMessage: (evt: { data: unknown }, ws: WSContext) => void;
  onClose: (evt: unknown, ws: WSContext) => void;
}

/**
 * WebSocket hub (SPEC §6). Any number of viewers may attach to the same
 * (stream, term); output/status/exit broadcast to all of them and stdin is
 * accepted from any (last-writer-wins, like tmux). Auth is the mandatory
 * first message — browsers cannot set WS headers.
 */
export class WsGateway {
  private readonly viewers = new Map<string, Set<WSContext>>();
  private readonly statusSubs = new Set<WSContext>();

  constructor(private readonly deps: WsGatewayDeps) {
    deps.ptys.on('data', (e: PtyDataEvent) => {
      this.broadcast(this.key(e.stream, e.term), {
        t: 'output',
        session: e.stream,
        term: e.term,
        data: e.data,
      });
    });
    deps.ptys.on('exit', (e: PtyExitEvent) => {
      this.broadcast(this.key(e.stream, e.term), {
        t: 'exit',
        session: e.stream,
        term: e.term,
        code: e.exitCode,
      });
    });
    deps.service.on('status', (e: StatusEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'status',
          session: e.session,
          status: e.status,
          last_activity_at: e.last_activity_at,
        });
      }
    });
    deps.service.on('renamed', (e: RenameEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'renamed',
          session: e.session,
          title: e.title,
          agent_title: e.agent_title,
          osc_title: e.osc_title,
        });
      }
    });
  }

  /** Per-connection handler factory for upgradeWebSocket. */
  connection(): WsEventHandlers {
    let authed = false;
    const attached = new Set<string>();

    const onMessage = (evt: { data: unknown }, ws: WSContext): void => {
      const parsed = wsClientMessageSchema.safeParse(this.decode(evt.data));
      if (!parsed.success) {
        this.send(ws, { t: 'error', message: 'malformed message' });
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'auth') {
        if (this.tokenMatches(msg.token)) {
          authed = true;
        } else {
          this.send(ws, { t: 'error', message: 'invalid token' });
          ws.close(4401, 'invalid token');
        }
        return;
      }
      if (!authed) {
        this.send(ws, { t: 'error', message: 'authenticate first' });
        ws.close(4401, 'authenticate first');
        return;
      }
      try {
        switch (msg.t) {
          case 'attach': {
            this.assertStream(msg.session);
            const key = this.key(msg.session, msg.term);
            let set = this.viewers.get(key);
            if (!set) this.viewers.set(key, (set = new Set()));
            set.add(ws);
            attached.add(key);
            const tail = this.deps.logs.readTail(msg.session, msg.term);
            this.send(ws, { t: 'replay', session: msg.session, term: msg.term, data: tail });
            this.deps.ptys.resize(msg.session, msg.term, msg.cols, msg.rows);
            break;
          }
          case 'stdin':
            this.deps.ptys.write(msg.session, msg.term, msg.data);
            break;
          case 'resize':
            this.deps.ptys.resize(msg.session, msg.term, msg.cols, msg.rows);
            break;
          case 'detach': {
            const key = this.key(msg.session, msg.term);
            this.viewers.get(key)?.delete(ws);
            attached.delete(key);
            break;
          }
          case 'spawn-shell': {
            const term = this.deps.service.spawnShell(msg.session);
            this.send(ws, { t: 'shell-spawned', session: msg.session, term });
            break;
          }
          case 'subscribe-status':
            this.statusSubs.add(ws);
            break;
        }
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'internal error';
        this.send(ws, { t: 'error', message });
      }
    };

    const onClose = (_evt: unknown, ws: WSContext): void => {
      for (const key of attached) this.viewers.get(key)?.delete(ws);
      this.statusSubs.delete(ws);
    };

    return { onMessage, onClose };
  }

  /** Session uuids must exist; `login-<id>` streams attach like sessions (SPEC §6). */
  private assertStream(stream: string): void {
    if (/^login-[0-9]+$/.test(stream)) return;
    this.deps.service.get(stream); // throws 404 for unknown sessions
  }

  private tokenMatches(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.deps.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private decode(data: unknown): unknown {
    try {
      return JSON.parse(String(data));
    } catch {
      return null;
    }
  }

  private send(ws: WSContext, msg: WsServerMessage): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  private broadcast(key: string, msg: WsServerMessage): void {
    const set = this.viewers.get(key);
    if (!set) return;
    const encoded = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(encoded);
    }
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }
}
