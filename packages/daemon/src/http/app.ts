import { Hono } from 'hono';
import { bearerAuth, hostOriginGuard } from '../security/middleware.js';
import { ApiError } from './errors.js';
import { versionRoutes } from './routes/version.js';
import { staticAssets } from './static.js';

export interface AppDeps {
  version: string;
  /** Absolute dir of embedded UI assets; null in tests that don't exercise static serving. */
  assetsDir: string | null;
  token: string;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Cast: Hono types statuses as literals; ours is a runtime value.
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  app.use('/api/*', hostOriginGuard());
  app.use('/api/*', bearerAuth(deps.token));
  app.route('/api/version', versionRoutes(deps.version));
  if (deps.assetsDir) app.use('*', staticAssets(deps.assetsDir));
  return app;
}
