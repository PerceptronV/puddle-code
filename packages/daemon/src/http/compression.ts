import type { MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { responsePrefix } from './response-prefix.js';

const THRESHOLD = 1024;
const encode = compress({ encoding: 'gzip', threshold: THRESHOLD });

/** Compress JSON before the tunnel; leave files, SSE and application proxies streaming verbatim. */
export const compressJson: MiddlewareHandler = async (c, next) => {
  await next();
  if (
    c.req.method === 'HEAD' ||
    c.res.status !== 200 ||
    !c.res.body ||
    !c.res.headers.get('content-type')?.startsWith('application/json') ||
    c.res.headers.has('content-encoding') ||
    /\bno-transform\b/i.test(c.res.headers.get('cache-control') ?? '')
  )
    return;

  c.header('Vary', 'Accept-Encoding', { append: true });
  // Hono JSON responses have no Content-Length. Inspect only a small prefix,
  // otherwise the compression middleware also compresses every tiny status reply.
  // With no acceptable encoding it can return without touching the body at all.
  if (!/\bgzip\b|\*/i.test(c.req.header('accept-encoding') ?? '')) return;
  const prefix = await responsePrefix(c.res.body, THRESHOLD - 1);
  c.res = new Response(prefix.stream(), c.res);
  if (prefix.bytes >= THRESHOLD) await encode(c, async () => {});
};
