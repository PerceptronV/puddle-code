import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { responsePrefix } from './response-prefix.js';

const MAX_VALIDATED_BYTES = 1024 * 1024;
const MIN_VALIDATED_BYTES = 4096;

/** Standard private HTTP revalidation: unchanged GET JSON pays headers, not another full body. */
export const revalidateJson: MiddlewareHandler = async (c, next) => {
  await next();
  if (
    // The relay carries structured replies, not HTTP validators. Profile filters
    // may also finish projecting the response after this middleware unwinds.
    (c.var as { remoteProfile?: string }).remoteProfile !== undefined ||
    c.req.method !== 'GET' ||
    c.res.status !== 200 ||
    !c.res.body ||
    !c.res.headers.get('content-type')?.startsWith('application/json') ||
    c.res.headers.has('content-encoding') ||
    c.res.headers.has('etag') ||
    c.res.headers.has('cache-control')
  )
    return;

  const prefix = await responsePrefix(c.res.body, MAX_VALIDATED_BYTES);
  c.res = new Response(prefix.stream(), c.res);
  // Validator request/response headers would outweigh tiny status bodies.
  if (!prefix.ended || prefix.bytes < MIN_VALIDATED_BYTES || prefix.bytes > MAX_VALIDATED_BYTES)
    return;
  const hash = createHash('sha256');
  for (const chunk of prefix.chunks) hash.update(chunk);
  const tag = `W/"${hash.digest('base64url')}"`;
  c.header('ETag', tag);
  // Revalidate on EVERY use, after host/profile authority and the route ran.
  // Never share a cached representation between browser credentials.
  c.header('Cache-Control', 'private, no-cache');
  c.header('Vary', 'Authorization, Accept-Encoding', { append: true });
  const matches = c.req
    .header('if-none-match')
    ?.split(',')
    .some((candidate) => {
      const value = candidate.trim();
      return value === '*' || value.replace(/^W\//, '') === tag.slice(2);
    });
  if (matches) {
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    headers.delete('content-type');
    await c.res.body?.cancel();
    c.res = new Response(null, { status: 304, headers });
  }
};
