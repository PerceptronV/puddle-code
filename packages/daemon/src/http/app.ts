import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStateStore } from '../db/stores/project-states.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RemovalStore } from '../db/stores/removals.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { PuddlePaths } from '../paths.js';
import type { PortScanner } from '../ports/scanner.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { bearerAuth, hostOriginGuard } from '../security/middleware.js';
import type { SessionService } from '../sessions/service.js';
import type { WorktreeManager } from '../worktrees/manager.js';
import type { WsGateway } from '../ws/gateway.js';
import { ApiError } from './errors.js';
import { accountRoutes } from './routes/accounts.js';
import { agentRoutes } from './routes/agents.js';
import { configRoutes } from './routes/config.js';
import { fsRoutes } from './routes/fs.js';
import { hostRoutes } from './routes/host.js';
import { profileRoutes } from './routes/profiles.js';
import { projectRoutes } from './routes/projects.js';
import { repoRoutes } from './routes/repos.js';
import { sessionRoutes } from './routes/sessions.js';
import { versionRoutes } from './routes/version.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { staticAssets } from './static.js';

/** Everything the REST + WS surface needs; `api` is absent in narrow tests. */
export interface AppDeps {
  version: string;
  /** Absolute dir of embedded UI assets; null in tests that don't exercise static serving. */
  assetsDir: string | null;
  token: string;
  api?: {
    paths: PuddlePaths;
    profiles: ProfileStore;
    accounts: AccountStore;
    repos: RepoStore;
    projects: ProjectStore;
    projectStates: ProjectStateStore;
    removals: RemovalStore;
    sessions: SessionStore;
    adapters: AdapterRegistry;
    ptys: PtyManager;
    worktrees: WorktreeManager;
    service: SessionService;
    scanner: PortScanner;
  };
  ws?: {
    gateway: WsGateway;
    upgradeWebSocket: UpgradeWebSocket;
  };
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

  if (deps.api) {
    const api = deps.api;
    app.route('/api/profiles', profileRoutes(api));
    app.route('/api/accounts', accountRoutes(api));
    app.route('/api/agents', agentRoutes(api));
    app.route('/api/repos', repoRoutes(api));
    app.route('/api/projects', projectRoutes(api));
    app.route('/api/sessions', sessionRoutes(api));
    app.route('/api/config', configRoutes(api));
    app.route('/api/fs', fsRoutes());
    app.route('/api/worktrees', worktreeRoutes(api));
    app.route('/api/host', hostRoutes());
  }

  if (deps.ws) {
    const { gateway, upgradeWebSocket } = deps.ws;
    app.use('/ws', hostOriginGuard()); // token auth is the first WS message
    app.get(
      '/ws',
      upgradeWebSocket(() => gateway.connection()),
    );
  }

  if (deps.assetsDir) app.use('*', staticAssets(deps.assetsDir));
  return app;
}
