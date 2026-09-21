import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  REMOTE_POLICY,
  remoteIdSchema,
  registerHostRequestSchema,
  redeemRegistrationSchema,
} from '@puddle/shared';
import type { RemoteConfig } from './config.js';
import { createServiceAuth } from './auth.js';
import { ServiceStore } from './store.js';
import { Relay } from './relay.js';
import { RateLimit } from './rate-limit.js';

export async function startRemoteService(
  config: RemoteConfig,
  deliver?: (to: string, subject: string, url: string) => Promise<void>,
) {
  const store = new ServiceStore(config.home);
  const auth = await createServiceAuth(config, store, deliver);
  const limits = new RateLimit(180);
  const registrationLimits = new RateLimit(10);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    c.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header('strict-transport-security', 'max-age=31536000');
    if (c.req.header('host') !== new URL(config.service).host)
      return c.json({ error: 'Invalid host' }, 403);
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== config.app && origin !== config.service)
      return c.json({ error: 'Invalid origin' }, 403);
    if (origin === config.app) {
      c.header('access-control-allow-origin', config.app);
      c.header('access-control-allow-credentials', 'true');
      c.header('vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      if (origin !== config.app) return c.body(null, 403);
      c.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      c.header('access-control-allow-headers', 'Content-Type');
      return c.body(null, 204);
    }
    // Registration redemption is a machine-only bearer exchange, never cookie authenticated.
    if (!['GET', 'HEAD'].includes(c.req.method) && c.req.path !== '/remote/register' && !origin)
      return c.json({ error: 'Origin required' }, 403);
    if (!limits.take(c.req.header('x-puddle-peer-ip') ?? ''))
      return c.json({ error: 'Too many requests' }, 429);
    await next();
    // Auth handlers return their own Response. Apply browser/security headers to
    // the final response too, preserving Better Auth's separate Set-Cookie fields.
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    c.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header('strict-transport-security', 'max-age=31536000');
    if (origin === config.app) {
      c.header('access-control-allow-origin', config.app);
      c.header('access-control-allow-credentials', 'true');
      c.header('vary', 'Origin');
    }
  });
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  app.onError(() =>
    Response.json(
      { error: 'Remote service operation failed' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    ),
  );
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.all('/api/auth/*', async (c) => {
    const response = await auth.handle(c.req.raw);
    if (response.ok && c.req.method === 'POST') void relay.recheck();
    return response;
  });
  app.get('/remote/config', (c) =>
    c.json({
      providers: [...(config.google ? ['google'] : []), ...(config.github ? ['github'] : [])],
      email: true,
      protocol: 1,
    }),
  );
  app.get('/remote/me', async (c) => {
    const session = await auth.session(c.req.raw.headers);
    return c.json({
      user: session?.user ?? null,
      mfaRequired: !!session?.user.twoFactorEnabled && !store.hasMfa(session.session.token),
    });
  });
  app.get('/remote/hosts', async (c) => {
    const session = await auth.authorised(c.req.raw.headers);
    if (!session) return c.json({ error: 'Sign in and complete verification first' }, 401);
    return c.json(
      store
        .list(session.user.id)
        .map((host) => ({ id: host.id, label: host.label, online: relay.online(host.id) })),
    );
  });
  app.post('/remote/hosts', async (c) => {
    const session = await auth.authorised(c.req.raw.headers);
    if (!session) return c.json({ error: 'Sign in and complete verification first' }, 401);
    if (!registrationLimits.take(session.user.id))
      return c.json({ error: 'Too many registrations' }, 429);
    const body = registerHostRequestSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'A host name is required' }, 400);
    return c.json(store.register(session.user.id, body.data.label), 201);
  });
  app.delete('/remote/hosts/:id', async (c) => {
    const session = await auth.authorised(c.req.raw.headers);
    if (!session) return c.json({ error: 'Sign in and complete verification first' }, 401);
    const id = remoteIdSchema.parse(c.req.param('id'));
    if (store.host(id)?.account !== session.user.id) return c.json({ error: 'Unknown host' }, 404);
    store.remove(id, session.user.id);
    relay.remove(id);
    return c.body(null, 204);
  });
  app.post('/remote/register', async (c) => {
    if (c.req.header('origin') !== undefined || c.req.header('cookie') !== undefined)
      return c.json({ error: 'Host registration requires the local connector' }, 403);
    const body = redeemRegistrationSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'Invalid registration' }, 400);
    try {
      return c.json(store.redeem(body.data.code));
    } catch {
      return c.json({ error: 'Registration expired or used' }, 403);
    }
  });
  const listener = getRequestListener(app.fetch);
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    // No implicitly trusted proxy identity or caller-provided IP headers.
    for (const name of Object.keys(req.headers))
      if (/^(forwarded|x-forwarded-|x-puddle-)/.test(name)) delete req.headers[name];
    req.headers['x-puddle-peer-ip'] = req.socket.remoteAddress ?? '';
    void listener(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = REMOTE_POLICY.connections * 4;
  const relay = new Relay(server, config, auth, store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.address, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const prune = setInterval(() => store.prune(), 60_000);
  return {
    server,
    store,
    auth,
    relay,
    async close() {
      clearInterval(prune);
      relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
