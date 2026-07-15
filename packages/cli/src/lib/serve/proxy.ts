import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Where /api, /ws, and /proxy requests go: the daemon port locally, the SSH
 * tunnel's local end remotely. A mutable ref, not a value — a tunnel
 * reconnect that lands on a new local port repoints it without restarting
 * the UI server.
 */
export interface ProxyTarget {
  host: string;
  port: number;
}

/**
 * Hop-by-hop headers (RFC 7230 §6.1), same set as the daemon's tier-2 proxy.
 * Everything else — including Authorization and Cookie — passes through
 * verbatim: the CLI adds no credentials and strips none; the browser's token
 * must reach the daemon exactly as it left the page (SPEC §2).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Statuses that must not carry a body. */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

function forwardHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Verbatim HTTP forward to the target: `req.url` is the raw path + query,
 * never decoded or re-encoded; bodies stream both ways (SSE/chunked-safe).
 * A connect failure synthesises a 502 in the daemon's error envelope so the
 * web UI's ApiError path renders it; upstream statuses pass through as-is.
 */
export function proxyRequest(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req),
  });

  upstream.on('response', (upstreamRes) => {
    const headers = { ...upstreamRes.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    if (isBodylessStatus(upstreamRes.statusCode ?? 0)) {
      res.end();
      upstreamRes.resume();
      return;
    }
    upstreamRes.pipe(res);
  });

  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 'daemon_unreachable', message: 'the puddle daemon is not reachable' },
      }),
    );
  });

  // A dropped browser connection must not leak the upstream request.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Tracks live client↔upstream socket pairs so close() can tear them down —
 * outbound sockets opened via http.request are not covered by
 * server.closeAllConnections() (same rationale as the daemon's
 * proxy/sockets.ts).
 */
export class ProxySocketTracker {
  private readonly pairs = new Set<{ client: Duplex; upstream: Duplex }>();

  add(client: Duplex, upstream: Duplex): void {
    const pair = { client, upstream };
    this.pairs.add(pair);
    const drop = () => this.pairs.delete(pair);
    client.once('close', drop);
    upstream.once('close', drop);
  }

  destroyAll(): void {
    for (const { client, upstream } of this.pairs) {
      client.destroy();
      upstream.destroy();
    }
    this.pairs.clear();
  }
}

/**
 * Verbatim WebSocket splice to the target — covers /ws and /proxy WS alike
 * (the daemon does its own auth and scoping on the other side). Handshake
 * headers pass through untouched apart from hop-by-hop normalisation being
 * skipped entirely: connection/upgrade/sec-websocket-* are load-bearing here.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
  tracker: ProxySocketTracker,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = value;
  }
  const upstreamReq = httpRequest({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  });

  if (head.length > 0) socket.unshift(head);

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead: Buffer) => {
    if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
    socket.write(
      statusHead(101, upstreamRes.statusMessage || 'Switching Protocols', upstreamRes.headers),
    );
    tracker.add(socket, upstreamSocket);
    const teardown = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.on('error', teardown);
    upstreamSocket.on('error', teardown);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  // Upstream refused the upgrade with a plain HTTP response: relay and close.
  upstreamReq.on('response', (upstreamRes) => {
    const headers = { ...upstreamRes.headers };
    delete headers['transfer-encoding'];
    headers.connection = 'close';
    socket.write(
      statusHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage ?? '', headers),
    );
    tracker.add(socket, upstreamRes.socket ?? socket);
    upstreamRes.pipe(socket);
  });
  upstreamReq.on('error', () => refuse(socket, 502, 'Bad Gateway'));
  upstreamReq.end();
}

function statusHead(
  status: number,
  message: string,
  headers: Record<string, string | string[] | undefined>,
): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

/** Reject a handshake with a minimal HTTP response, then close the socket. */
export function refuse(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}
