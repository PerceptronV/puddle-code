import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type { AgentAdapter } from './agents/adapter.js';
import { claudeCode } from './agents/claude-code.js';
import { AdapterRegistry } from './agents/registry.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/db.js';
import { AccountStore } from './db/stores/accounts.js';
import { EventStore } from './db/stores/events.js';
import { ProfileStore } from './db/stores/profiles.js';
import { ProjectStateStore } from './db/stores/project-states.js';
import { ProjectStore } from './db/stores/projects.js';
import { RepoStore } from './db/stores/repos.js';
import { SessionStore } from './db/stores/sessions.js';
import { KeyedMutex } from './git/mutex.js';
import { buildApp } from './http/app.js';
import { LogStore } from './logs/log-store.js';
import { ensureHome, resolvePaths } from './paths.js';
import { PtyManager } from './pty/pty-manager.js';
import { ensureToken } from './security/token.js';
import { OnboardingNotesSync } from './sessions/onboarding.js';
import { reconcilePass } from './sessions/reconcile.js';
import { SessionService } from './sessions/service.js';
import { WorktreeManager } from './worktrees/manager.js';
import { WsGateway } from './ws/gateway.js';

export interface DaemonOptions {
  /** Overrides PUDDLE_HOME / ~/.puddle (tests). */
  home?: string;
  /** Overrides config.json's port; 0 picks a free port (tests). */
  port?: number;
  /** Adapter set; defaults to the real ones (tests inject fakes). */
  adapters?: AgentAdapter[];
  /** Embedded UI dir; null serves no assets (tests). */
  assetsDir?: string | null;
  version?: string;
  /** Quiet window for waiting_input detection (tests shrink it). */
  statusQuietMs?: number;
}

export interface RunningDaemon {
  port: number;
  token: string;
  paths: ReturnType<typeof resolvePaths>;
  service: SessionService;
  stop(): Promise<void>;
}

/**
 * Composition root: constructs every subsystem, runs the boot reconcile pass,
 * starts the periodic fetch loop and the HTTP+WS server.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.home);
  ensureHome(paths);
  const config = loadConfig(paths);
  const token = ensureToken(paths);
  const db = openDatabase(paths.dbFile);

  const profiles = new ProfileStore(db);
  const accounts = new AccountStore(db);
  const repos = new RepoStore(db);
  const projects = new ProjectStore(db);
  const projectStates = new ProjectStateStore(db);
  const sessions = new SessionStore(db);
  const events = new EventStore(db);

  const logs = new LogStore(paths.logsDir, config.replayBytes);
  const ptys = new PtyManager(logs);
  const worktrees = new WorktreeManager({ paths, mutex: new KeyedMutex(), repos, sessions });
  const onboarding = new OnboardingNotesSync({ repos, events });
  const adapters = new AdapterRegistry(opts.adapters ?? [claudeCode]);
  const service = new SessionService({
    profiles,
    accounts,
    repos,
    projects,
    sessions,
    events,
    worktrees,
    ptys,
    adapters,
    logs,
    onboarding,
    statusQuietMs: opts.statusQuietMs,
  });

  const sweptStates = projectStates.gc(config.uiStateRetentionDays);
  if (sweptStates > 0) console.log(`ui-state gc: ${sweptStates} stale row(s) removed`);

  const reconciled = reconcilePass({ sessions, events, projects, onboarding });
  if (reconciled.interrupted.length > 0) {
    console.log(`reconcile: ${reconciled.interrupted.length} session(s) marked interrupted`);
  }
  // Auto-resume is OFF by default (SPEC §4); interrupted sessions surface in the UI.
  if (config.autoResume) {
    for (const id of reconciled.interrupted) {
      await service.resume(id).catch((e) => console.warn(`auto-resume ${id} failed: ${e.message}`));
    }
  }

  // Periodic fetch for repos with at least one non-archived session (SPEC §4).
  const fetchTimer = setInterval(
    () => {
      for (const repo of repos.list()) {
        if (!repo.fetch_enabled) continue;
        if (sessions.listActiveByRepo(repo.id).length === 0) continue;
        void worktrees
          .fetchRepo(repo)
          .catch((e) => console.warn(`periodic fetch failed for ${repo.path}: ${e.message}`));
      }
    },
    config.fetchIntervalMinutes * 60 * 1000,
  );
  fetchTimer.unref();

  const gateway = new WsGateway({ token, ptys, logs, service });
  const app = buildApp({
    version: opts.version ?? '0.0.0',
    assetsDir: opts.assetsDir ?? null,
    token,
    api: {
      paths,
      profiles,
      accounts,
      repos,
      projects,
      projectStates,
      adapters,
      ptys,
      worktrees,
      service,
    },
    ws: { gateway, upgradeWebSocket },
  });

  const wss = new WebSocketServer({ noServer: true });
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((r) => (resolvePort = r));
  const server: ServerType = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: opts.port ?? config.port,
      websocket: { server: wss },
    },
    (info) => resolvePort(info.port),
  );
  const port = await portPromise;

  return {
    port,
    token,
    paths,
    service,
    async stop() {
      clearInterval(fetchTimer);
      onboarding.dispose();
      // Freeze session rows at their live statuses (reconcile → interrupted),
      // then wait for PTY exits so nothing touches the db after close.
      service.beginShutdown();
      ptys.killAll();
      const deadline = Date.now() + 3000;
      while (ptys.liveCount() > 0) {
        if (Date.now() > deadline) {
          ptys.killAll(undefined, 'SIGKILL');
          await new Promise((r) => setTimeout(r, 200));
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      logs.closeAll();
      await new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        // Idle keep-alive and WS sockets would hold close() open forever.
        if ('closeAllConnections' in server) {
          (server as import('node:http').Server).closeAllConnections();
        }
      });
      db.close();
    },
  };
}
