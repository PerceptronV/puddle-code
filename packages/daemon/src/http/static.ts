import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { MiddlewareHandler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function fileResponse(path: string): Response {
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(stream, {
    headers: { 'content-type': type, 'content-length': String(statSync(path).size) },
  });
}

/**
 * Serve static files from an absolute directory with an index.html fallback
 * for SPA routes. Written in-house because @hono/node-server's serveStatic
 * resolves its root relative to process.cwd(), which is meaningless for a
 * daemon launched by systemd.
 */
export function staticAssets(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const requested = normalize(join(root, decodeURIComponent(new URL(c.req.url).pathname)));
    // Confinement: anything escaping the root falls through to the SPA index.
    const candidate = requested.startsWith(root + sep) || requested === root ? requested : root;
    if (existsSync(candidate) && statSync(candidate).isFile()) return fileResponse(candidate);
    const index = join(root, 'index.html');
    if (existsSync(index)) return fileResponse(index);
    return next();
  };
}
