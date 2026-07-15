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
import { RemovalStore } from './db/stores/removals.js';
import { RepoStore } from './db/stores/repos.js';
import { reconcileProfileDirs } from './db/profile-dirs.js';
import { SessionStore } from './db/stores/sessions.js';
import { KeyedMutex } from './git/mutex.js';
import { buildApp } from './http/app.js';
import { LogStore } from './logs/log-store.js';
import { ensureHome, resolvePaths } from './paths.js';
import { PortScanner } from './ports/scanner.js';
import { attachProxyUpgrade } from './proxy/upgrade.js';
import { ProxySocketTracker } from './proxy/sockets.js';
import { PtyManager } from './pty/pty-manager.js';
import { ensureToken } from './security/token.js';
import { ConversationShare } from './sessions/conversation-share.js';
import { MarkerFileSync } from './sessions/onboarding.js';
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
  const removals = new RemovalStore(db);
  const sessions = new SessionStore(db);
  const events = new EventStore(db);

  const logs = new LogStore(paths.logsDir, config.replayBytes);
  const ptys = new PtyManager(logs);
  const scanner = new PortScanner({ ptys });
  const worktrees = new WorktreeManager({ paths, mutex: new KeyedMutex(), repos, sessions });
  const onboarding = new MarkerFileSync({ repos, events, sessions });
  const adapters = new AdapterRegistry(opts.adapters ?? [claudeCode]);
  const share = new ConversationShare({
    accounts,
    adapters,
    paths,
    mutex: new KeyedMutex(),
    events,
  });
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
    share,
    statusQuietMs: opts.statusQuietMs,
  });

  // Agent-chosen titles (`.puddle/session-title`) go through the service so the
  // rename broadcasts to attached clients, exactly like a UI rename.
  onboarding.setTitleSink((id, title) => service.applyAgentTitle(id, title));

  // Migration 004 rewrote config-dir paths to id-keyed; rename the dirs.
  reconcileProfileDirs(profiles.list(), paths);

  // Stored logged-in flags can lie (keychain-bound creds die with a path
  // change) — re-verify each account in the background so badges are honest.
  void Promise.allSettled(
    accounts.list().map(async (account) => {
      try {
        const adapter = adapters.get(account.agent_type);
        adapter.reconcileConfigDir?.(account); // idempotent upkeep (e.g. status line)
        if (adapter.checkLoggedIn) {
          accounts.setLoggedIn(account.id, await adapter.checkLoggedIn(account));
        }
      } catch {
        // Unknown adapter or probe failure: leave the stored flag alone.
      }
    }),
  );

  // Repair the shared conversation store's symlinks (missing/dangling) so
  // every account of a profile can still resolve its adopted conversations.
  void share.reconcile().catch((e) => console.warn(`conversation reconcile failed: ${e.message}`));

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

  const tracker = new ProxySocketTracker();
  const gateway = new WsGateway({ token, ptys, logs, service });
  const app = buildApp({
    version: opts.version ?? '0.0.0',
    token,
    api: {
      paths,
      profiles,
      accounts,
      repos,
      projects,
      projectStates,
      removals,
      sessions,
      adapters,
      ptys,
      worktrees,
      service,
      share,
      scanner,
      tracker,
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

  // Register the tier-2 proxy's raw WebSocket upgrade listener AFTER serve() so
  // it becomes the SECOND 'upgrade' listener — see attachProxyUpgrade for why
  // that ordering is load-bearing. /ws stays with @hono/node-server's own listener.
  const detachProxy = attachProxyUpgrade(server as import('node:http').Server, {
    sessions,
    scanner,
    token,
    tracker,
  });

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
      // Proxied WebSocket sockets (client + outbound upstream) are not covered
      // by closeAllConnections and would hold the process open — detach the
      // listener and tear the pairs down before closing the server.
      detachProxy();
      tracker.destroyAll();
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
