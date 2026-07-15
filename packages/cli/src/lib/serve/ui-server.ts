import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CliError } from '../types.js';
import { isLocalHostHeader, isLocalOrigin } from './guard.js';
import { recoverProxiedPath } from './proxy-recovery.js';
import { createStaticHandler } from './static.js';
import {
  ProxySocketTracker,
  proxyRequest,
  proxyUpgrade,
  refuse,
  type ProxyTarget,
} from './proxy.js';

export interface UiServerOptions {
  /** Directory holding the built web UI (dist/public). */
  assetsDir: string;
  /** Preferred port; auto-picks the next free one unless `strictPort`. */
  port?: number;
  /** An explicitly requested port that is busy is a hard error. */
  strictPort?: boolean;
  /**
   * Never auto-pick this port (the daemon's own port in local mode): a UI
   * server squatting it would make the next `puddle start` handshake with a
   * proxy instead of the daemon. Ignored for an explicit --port.
   */
  avoidPort?: number;
  /** Initial proxy target (daemon port locally, tunnel local end remotely). */
  target: ProxyTarget;
}

export interface UiServer {
  port: number;
  origin: string;
  /**
   * Per-instance identity, echoed on every response as X-Puddle-Cockpit —
   * how the cockpit registry tells this server from a recycled pid or a
   * stranger on the same port.
   */
  nonce: string;
  /** Repoint /api + /ws + /proxy (a reconnected tunnel may move ports). */
  setTarget(target: ProxyTarget): void;
  close(): Promise<void>;
}

export const DEFAULT_UI_PORT = 7433;
const MAX_PORT_PROBES = 50;

function isProxiedPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? '';
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/ws' ||
    pathname === '/proxy' ||
    pathname.startsWith('/proxy/')
  );
}

/**
 * The one stable local origin (SPEC §2): serves the web UI tokenlessly and
 * reverse-proxies /api + /ws + /proxy verbatim to the daemon target, with the
 * daemon's own Host/Origin checks applied at this port too.
 */
export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const target: ProxyTarget = { ...opts.target };
  const tracker = new ProxySocketTracker();
  const serveStatic = createStaticHandler(opts.assetsDir);
  const nonce = randomUUID();

  const server = createServer((req, res) => {
    res.setHeader('x-puddle-cockpit', nonce);
    const url = req.url ?? '/';
    // A proxied page's absolute-path subresource lands outside /proxy/…;
    // bounce it back under the page's prefix before any other routing (its
    // /api and /assets belong to the proxied app, not to puddle).
    const recovered = recoverProxiedPath(req.headers.referer, url);
    if (recovered !== null) {
      res.writeHead(307, { location: recovered });
      res.end();
      return;
    }
    if (isProxiedPath(url)) {
      if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'forbidden_host', message: 'requests must address localhost' },
          }),
        );
        return;
      }
      proxyRequest(req, res, target);
      return;
    }
    serveStatic(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!isProxiedPath(req.url ?? '/')) return refuse(socket, 404, 'Not Found');
    if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
      return refuse(socket, 403, 'Forbidden');
    }
    proxyUpgrade(req, socket, head, target, tracker);
  });

  const port = await listen(
    server,
    opts.port ?? DEFAULT_UI_PORT,
    opts.strictPort ?? false,
    opts.avoidPort,
  );

  return {
    port,
    origin: `http://localhost:${port}`,
    nonce,
    setTarget(next) {
      target.host = next.host;
      target.port = next.port;
    },
    close() {
      tracker.destroyAll();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function listen(
  server: Server,
  startPort: number,
  strict: boolean,
  avoidPort?: number,
): Promise<number> {
  for (let probe = 0; probe < MAX_PORT_PROBES; probe += 1) {
    const port = startPort + probe;
    if (!strict && port === avoidPort) continue;
    const ok = await new Promise<boolean>((resolve, rejectListen) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(false);
        else rejectListen(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (ok) return port;
    if (strict) {
      throw new CliError(
        'port_in_use',
        `port ${startPort} is already in use`,
        'drop --port to let puddle pick the next free port',
      );
    }
  }
  throw new CliError(
    'port_in_use',
    `no free port found in ${startPort}–${startPort + MAX_PORT_PROBES - 1}`,
  );
}
