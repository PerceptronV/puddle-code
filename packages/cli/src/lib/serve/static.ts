import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Static web-UI assets with an index.html fallback for SPA routes — the
 * daemon's former embedded serving (its http/static.ts), reborn as a plain
 * node:http handler now that the CLI owns the UI origin (SPEC §2). Tokenless
 * by design: only /api, /ws, and /proxy carry credentials.
 */
export function createStaticHandler(
  rootDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const requested = normalize(join(root, decodeURIComponent(pathname)));
    // Confinement: anything escaping the root falls through to the SPA index.
    const candidate = requested.startsWith(root + sep) || requested === root ? requested : root;
    const file =
      existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}
