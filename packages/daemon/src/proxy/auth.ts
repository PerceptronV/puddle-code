import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.js';

/**
 * Auth for the tier-2 reverse proxy (SPEC §2). A browser tab that navigates to
 * `/proxy/...` cannot attach a bearer header, so three credentials are
 * accepted, in this order of preference:
 *   1. `Authorization: Bearer <token>` — programmatic clients (fetch, the CLI).
 *   2. Cookie `puddle_proxy=<token>` — set once by the query-param bootstrap
 *      below, then sent automatically on every subsequent same-path request
 *      (including the WebSocket handshake, which a browser can't header).
 *   3. Query `?puddle_token=<token>` — the one-shot bootstrap a link carries.
 *
 * The cookie value is the daemon token ITSELF, not a minted second secret: a
 * separate secret would add server-side state (a session table, expiry) without
 * moving any trust boundary — anyone who can read the daemon token already owns
 * the box. All comparisons are timing-safe.
 */

/** Timing-safe string compare that never short-circuits on length. */
function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Collapse a possibly-multi-valued header to its first string value. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Pull the `puddle_proxy` value out of a `Cookie` header, if present. */
function cookieToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'puddle_proxy') return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Remove ONLY the `puddle_proxy` pair from a `Cookie` header, preserving every
 * other cookie (and their ordering). Returns `undefined` when nothing remains,
 * so the caller can drop the header entirely rather than forward an empty one.
 */
export function stripProxyCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader.split(';').filter((part) => {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    return name !== 'puddle_proxy';
  });
  const joined = kept
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('; ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Plain predicate for the raw WS upgrade handler, which has no Hono context.
 * Accepts bearer, cookie, or the `puddle_token` query param (a browser WS
 * client sends the page's cookie automatically; Node test clients use the
 * query param, since neither can set request headers on the handshake).
 */
export function isProxyAuthorised(
  req: { headers: IncomingHttpHeaders; url: string | undefined },
  token: string,
): boolean {
  const auth = firstHeader(req.headers.authorization);
  if (auth && safeEqual(auth, `Bearer ${token}`)) return true;
  const cookie = cookieToken(firstHeader(req.headers.cookie));
  if (cookie && safeEqual(cookie, token)) return true;
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('puddle_token');
  if (query && safeEqual(query, token)) return true;
  return false;
}

/**
 * Hono middleware guarding `/proxy/*`. On a bare `?puddle_token=` GET it plants
 * the cookie and 302-redirects to the same URL with ONLY that param stripped —
 * the token never lingers in the address bar (the same instinct as the boot
 * token-fragment strip), while other query params survive. hostOriginGuard runs
 * separately (wired ahead of this in app.ts).
 */
export function proxyAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('authorization');
    if (auth && safeEqual(auth, `Bearer ${token}`)) return next();

    const cookie = cookieToken(c.req.header('cookie'));
    if (cookie && safeEqual(cookie, token)) return next();

    const url = new URL(c.req.url);
    const query = url.searchParams.get('puddle_token');
    if (query && safeEqual(query, token)) {
      if (c.req.method === 'GET') {
        url.searchParams.delete('puddle_token');
        return c.body(null, 302, {
          Location: url.pathname + url.search,
          'Set-Cookie': `puddle_proxy=${token}; Path=/proxy; HttpOnly; SameSite=Lax`,
        });
      }
      // Non-GET can't be safely redirected (would drop the body); authorise inline.
      return next();
    }

    throw new ApiError(401, 'unauthorised', 'missing or invalid proxy credentials');
  };
}
