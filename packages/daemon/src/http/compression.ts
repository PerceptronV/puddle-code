import type { MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';

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
  const reader = c.res.body.getReader();
  const prefix: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  while (bytes < THRESHOLD) {
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      break;
    }
    prefix.push(chunk.value);
    bytes += chunk.value.byteLength;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  c.res = new Response(body, c.res);
  if (bytes >= THRESHOLD) await encode(c, async () => {});
};
