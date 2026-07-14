import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.js';

/** WHATWG URL keeps brackets on IPv6 hostnames, hence both spellings. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

/**
 * Whether the `Host` header names a local machine (defeats DNS rebinding). A
 * missing header is not local. Exported as a pure predicate so the raw WS
 * upgrade handler — which has no Hono context — can reuse the exact same rule.
 */
export function isLocalHostHeader(host: string | undefined): boolean {
  return LOCAL_HOSTNAMES.has(hostnameOf(host ?? ''));
}

/**
 * Whether an `Origin` header is acceptable: absent, the opaque `'null'`, or a
 * localhost origin. Same rule the middleware applies, extracted so the raw WS
 * upgrade handler can call it directly.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Defeats DNS rebinding (Host must be a local name) and cross-site requests
 * (Origin, when present, must be a local origin). Ports are deliberately
 * ignored: through an SSH tunnel the browser's origin port is the local
 * tunnel port, not the daemon port. Delegates to the pure predicates above.
 */
export function hostOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!isLocalHostHeader(c.req.header('host'))) {
      throw new ApiError(403, 'forbidden_host', 'requests must address localhost');
    }
    if (!isLocalOrigin(c.req.header('origin'))) {
      throw new ApiError(403, 'forbidden_origin', 'cross-origin requests are not allowed');
    }
    await next();
  };
}

export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    const presented = Buffer.from(c.req.header('authorization') ?? '');
    const ok = presented.length === expected.length && timingSafeEqual(presented, expected);
    if (!ok) throw new ApiError(401, 'unauthorised', 'missing or invalid token');
    await next();
  };
}
