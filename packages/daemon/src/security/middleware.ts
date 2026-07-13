import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.js';

/** WHATWG URL keeps brackets on IPv6 hostnames, hence both spellings. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

function isLocalOrigin(origin: string): boolean {
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
 * tunnel port, not the daemon port.
 */
export function hostOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!LOCAL_HOSTNAMES.has(hostnameOf(c.req.header('host') ?? ''))) {
      throw new ApiError(403, 'forbidden_host', 'requests must address localhost');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== 'null' && !isLocalOrigin(origin)) {
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
