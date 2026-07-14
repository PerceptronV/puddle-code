import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
} from 'node:http';
import type { Duplex } from 'node:stream';
import type { SessionStore } from '../db/stores/sessions.js';
import type { PortScanner } from '../ports/scanner.js';
import { isLocalHostHeader, isLocalOrigin } from '../security/middleware.js';
import { isProxyAuthorised, stripProxyCookie } from './auth.js';
import type { ProxySocketTracker } from './sockets.js';

const PROXY_UPGRADE = /^\/proxy\/([^/]+)\/(\d+)(?:\/.*)?$/;

export interface UpgradeProxyDeps {
  sessions: Pick<SessionStore, 'get'>;
  scanner: Pick<PortScanner, 'hasPort'>;
  token: string;
  tracker: ProxySocketTracker;
}

/**
 * The tier-2 reverse proxy's WebSocket half (SPEC §9). Registered as a SECOND
 * `'upgrade'` listener on the Node server — MUST be attached AFTER
 * `@hono/node-server`'s `serve()` returns, so the library's own listener exists
 * first: its unclaimed-socket destroy branch only fires when
 * `server.listenerCount('upgrade') === 1`, and our presence (making it 2)
 * disarms it, leaving `/proxy` handshakes for us to claim while `/ws` stays with
 * the library (verified against @hono/node-server 2.0.8). Returns a disposer.
 */
export function attachProxyUpgrade(server: HttpServer, deps: UpgradeProxyDeps): () => void {
  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PROXY_UPGRADE.exec(pathnameOf(req.url));
    if (!match) return; // not ours — the library's listener owns /ws and the rest
    const [, sid, port] = match;
    if (sid === undefined || port === undefined) return;
    void forward(req, socket, head, sid, port, deps);
  };
  server.on('upgrade', handler);
  return () => server.off('upgrade', handler);
}

async function forward(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sid: string,
  port: string,
  deps: UpgradeProxyDeps,
): Promise<void> {
  // Security by hand, same order and rules as the HTTP path — but done on the
  // raw socket, since there is no Hono context here.
  if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    return refuse(socket, 403, 'Forbidden');
  }
  if (!isProxyAuthorised({ headers: req.headers, url: req.url }, deps.token)) {
    return refuse(socket, 401, 'Unauthorized');
  }
  try {
    deps.sessions.get(sid); // throws when unknown
  } catch {
    return refuse(socket, 404, 'Not Found');
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return refuse(socket, 400, 'Bad Request');
  }
  if (!(await deps.scanner.hasPort(sid, portNum))) {
    return refuse(socket, 403, 'Forbidden');
  }

  // Forward the handshake verbatim EXCEPT: strip the puddle_proxy cookie pair,
  // rewrite Host. connection/upgrade/sec-websocket-* are kept as-is (unlike the
  // HTTP path, they are load-bearing here). Raw path sliced textually.
  const rawPath = pathAfterPrefix(req.url, sid, port);
  const upstreamReq = httpRequest({
    host: '127.0.0.1',
    port: portNum,
    method: req.method,
    path: rawPath,
    headers: upgradeHeaders(req.headers, portNum),
  });

  // Put any early client bytes back on the socket so the later pipe carries them.
  if (head.length > 0) socket.unshift(head);

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead: Buffer) => {
    if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
    socket.write(
      statusHead(101, upstreamRes.statusMessage || 'Switching Protocols', upstreamRes.headers),
    );
    deps.tracker.add(socket, upstreamSocket);
    const teardown = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.on('error', teardown);
    upstreamSocket.on('error', teardown);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  // Upstream refused the upgrade (a plain HTTP response): relay it and close.
  upstreamReq.on('response', (upstreamRes) => {
    socket.write(
      statusHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage ?? '',
        upstreamRes.headers,
      ),
    );
    upstreamRes.pipe(socket);
  });
  upstreamReq.on('error', () => refuse(socket, 502, 'Bad Gateway'));
  upstreamReq.end();
}

/** Extract just the pathname (no query) from a raw request URL. */
function pathnameOf(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').pathname;
}

/** RAW substring after `/proxy/<sid>/<port>`, incl. query, undecoded; defaults to `/`. */
function pathAfterPrefix(url: string | undefined, sid: string, port: string): string {
  const raw = url ?? '/';
  const prefix = `/proxy/${sid}/${port}`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
  return rest.length > 0 ? rest : '/';
}

/** Copy handshake headers, strip only `puddle_proxy`, rewrite Host, keep the rest. */
function upgradeHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'host') continue;
    if (name === 'cookie') {
      const kept = stripProxyCookie(Array.isArray(value) ? value.join('; ') : value);
      if (kept !== undefined) out.cookie = kept;
      continue;
    }
    out[name] = value;
  }
  out.host = `127.0.0.1:${port}`;
  return out;
}

/** Serialise an HTTP status line + headers block for writing to a raw socket. */
function statusHead(status: number, message: string, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

/** Reject a handshake with a minimal HTTP response, then close the socket. */
function refuse(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}
