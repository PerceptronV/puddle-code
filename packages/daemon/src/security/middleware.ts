import { secret } from '@puddle/shared/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LeaseRegistry } from './leases.js';
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
 * Whether an `Origin` header is acceptable: absent or a localhost origin.
 * Opaque null origins are rejected. Same rule the middleware applies, extracted so the raw WS
 * upgrade handler can call it directly.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
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

/** Requests without a resource id get a non-renewable resource (short CLI reads).
 * Streaming clients supply an unguessable id and renew it on their control channel. */
export function bearerAuth(authority: LeaseRegistry): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith('/proxy/') && c.req.header('upgrade')) return next(); // raw upgrades authenticate separately
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const env = (c.env ?? {}) as { incoming?: IncomingMessage; outgoing?: ServerResponse };
    const resource = authority.attach(token, c.req.header('x-puddle-resource') ?? secret(), () => {
      env.outgoing?.destroy();
      env.incoming?.destroy();
    });
    if (!resource) throw new ApiError(401, 'upstream_expired', 'connection authority expired');
    env.outgoing?.once('close', () => resource.release());
    // Guard the web body without putting IncomingMessage into flowing mode:
    // a data listener here would consume uploads before their route reads them.
    if (c.req.raw.body) {
      const body = c.req.raw.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (resource.valid()) controller.enqueue(chunk);
            else controller.error(new Error('connection authority expired'));
          },
        }),
      );
      const init = { body, duplex: 'half' };
      c.req.raw = new Request(c.req.raw, init);
    }
    try {
      if (!resource.valid())
        throw new ApiError(401, 'upstream_expired', 'connection authority expired');
      await next();
      if (!resource.valid())
        throw new ApiError(401, 'upstream_expired', 'connection authority expired');
      const body = c.res.body;
      if (body) {
        c.res = new Response(
          body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (resource.valid()) controller.enqueue(chunk);
                else controller.error(new Error('connection authority expired'));
              },
              flush() {
                if (!env.outgoing) resource.release();
              },
            }),
          ),
          c.res,
        );
      } else resource.release();
    } catch (err) {
      resource.release();
      throw err;
    }
  };
}
