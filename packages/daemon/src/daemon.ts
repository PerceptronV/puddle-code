import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageMonitor } from './storage/monitor.js';
import { createAdaptorServer, upgradeWebSocket, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type { AgentAdapter } from './agents/adapter.js';
import { AccountObservations } from './agents/accounts/observations.js';
import { defaultAdapters } from './agents/defaults.js';
import { AdapterRegistry } from './agents/registry.js';
import { loadConfig, readConfig } from './config.js';
import { LogRetention } from './logs/retention.js';
import { NotebookKernels } from './notebooks/kernels.js';
import { createCodeProviders } from './code/provider.js';
import { createCodeTerminalLauncher } from './code/terminal.js';
import { CompilationService } from './compilation/service.js';
import { openDatabase } from './db/db.js';
import { requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { AccountStore } from './db/stores/accounts.js';
import { EventStore } from './db/stores/events.js';
import { ProfileStore } from './db/stores/profiles.js';
import { ProfileStateStore } from './db/stores/profile-states.js';
import { ProjectStore } from './db/stores/projects.js';
import { RemovalStore } from './db/stores/removals.js';
import { RepoStore } from './db/stores/repos.js';
import { LayoutStore } from './db/stores/layouts.js';
import { ScratchpadStore } from './db/stores/scratchpad.js';
import { reconcileProfileDirs } from './db/profile-dirs.js';
import { SessionStore } from './db/stores/sessions.js';
import { ConversationStore } from './db/stores/conversations.js';
import { CompilationSettingsStore } from './db/stores/compilation-settings.js';
import { KeyedMutex } from './git/mutex.js';
import { buildApp } from './http/app.js';
import { LogStore } from './logs/log-store.js';
import { LatexProvider } from './latex/provider.js';
import { ensureHome, resolvePaths } from './paths.js';
import { PortScanner } from './ports/scanner.js';
import { attachProxyUpgrade } from './proxy/upgrade.js';
import { ProxySocketTracker } from './proxy/sockets.js';
import { PtyManager } from './pty/pty-manager.js';
import { TerminalTheme } from './pty/terminal-theme.js';
import { installShellHooks } from './pty/shell-hooks.js';
import { clearRuntime, writeRuntime } from './runtime-file.js';
import {
  PROTOCOL_VERSION,
  hostUpdateTerminal,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '@puddle/shared';
import { LeaseRegistry } from './security/leases.js';
import { ProfileAccess } from './security/profile-access.js';
import { startHostControl } from './security/control.js';
import { ensureToken } from './security/token.js';
import { ConversationShare } from './sessions/conversation-share.js';
import { ConversationCatalogue } from './sessions/conversation-catalogue.js';
import { MarkerFileSync } from './sessions/onboarding.js';
import { reconcilePass } from './sessions/reconcile.js';
import { subscribePushNotifications } from './sessions/push-notifications.js';
import { SessionService, type SessionSwitchEvent } from './sessions/service.js';
import { RuntimeStore } from './db/stores/runtimes.js';
import { hostReleaseCapabilities } from '@puddle/shared';
import { HostUpdateCompatibility } from './updates/preflight/compatibility.js';
import { HostUpdateImpact } from './updates/preflight/impact.js';
import { HostUpdateCapacity } from './updates/preflight/capacity.js';
import { HostUpdateConnector } from './updates/preflight/connector.js';
import { HostUpdateInspection } from './updates/preflight/inspection.js';
import { HostUpdateSupervision } from './updates/preflight/supervision.js';
import { HostUpdateCoordinator } from './updates/coordinator.js';
import { RemoteHostUpdates } from './updates/remote/control.js';
import { stageRemoteHostUpdate } from './updates/remote/staging.js';
import { remoteMaintenanceAuthority } from './security/remote/maintenance.js';
import { HostReleaseChecks } from './updates/catalogue/releases.js';
import { hostUpdateCatalogue } from './updates/catalogue/inventory.js';
import { daemonUpdatePause } from './updates/maintenance/daemon.js';
import { DATABASE_SCHEMA_VERSION } from './db/migrations/index.js';
import { HostUpdateOperations } from './updates/operations/store.js';
import { HostAdmission } from './host/lifecycle/admission.js';
import { HostBackgroundTasks } from './host/lifecycle/background.js';
import { ReleaseCollectionMaintenance } from './host/installation/collection/maintenance.js';
import { RuntimeLogRetention } from './storage/runtime-retention/compaction.js';
import { startUpdateWorker } from './updates/worker/supervisor.js';
import { startUpdateRecoveryWorker } from './updates/recovery/worker/supervisor.js';
import { resolveInstalledRuntimeRelease } from './runtime/lifecycle/release.js';
import { RuntimeConnections } from './runtime/transport/connections.js';
import { RuntimeReconciler } from './runtime/controller/reconcile.js';
import { RuntimeNotifications } from './runtime/controller/notifications.js';
import { RuntimeServiceCleanup } from './runtime/lifecycle/service-cleanup.js';
import { RuntimeServiceCleanupStore } from './db/stores/runtime-service-cleanup.js';
import { notificationContent } from './sessions/notification-content.js';
import { RuntimeTerminals } from './runtime/controller/terminals.js';
import { RuntimeControls } from './runtime/controller/controls.js';
import { RuntimeProcesses } from './runtime/controller/processes.js';
import { RuntimeLauncher, type RuntimeLaunchConfiguration } from './runtime/lifecycle/launcher.js';
import { readRuntimeShellHooks } from './runtime/execution/shell-hooks.js';
import {
  acquireRuntimeControllerWhenAvailable,
  runtimeDirectory,
} from './runtime/ownership/storage.js';
import { runtimePriorRefs } from './runtime/controller/session-refs.js';
import { RuntimeProgrammeTurns } from './runtime/controller/programme-turns.js';
import { ProgrammeTurnStore } from './puddlang/runtime-turn-store.js';
import { WorktreeManager } from './worktrees/manager.js';
import { WsGateway } from './ws/gateway.js';
import { PuddlangService } from './puddlang/service.js';
import { PuddlangStore } from './puddlang/store.js';
import type { HostUpdateCheckpointReference } from '@puddle/shared';
import { HostUpdateCheckpointWriter } from './updates/checkpoints/store.js';
import { HostUpdateAdoptionWriter } from './updates/checkpoints/adoption.js';
import { pendingDaemonUpdateShutdown } from './updates/worker/shutdown.js';

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
  /** Override launch dependencies in tests; false isolates legacy migration fixtures only. */
  runtime?: RuntimeLaunchConfiguration | false;
}

export interface RunningDaemon {
  port: number;
  authority: LeaseRegistry;
  paths: ReturnType<typeof resolvePaths>;
  service: SessionService;
  updateInspection: HostUpdateInspection;
  admission: HostAdmission;
  /** Update evidence is accepted only for an already-dispatched daemon operation. */
  stop(update?: HostUpdateCheckpointReference): Promise<void>;
}

/**
 * Composition root: constructs every subsystem, runs the boot reconcile pass,
 * starts the periodic fetch loop and the HTTP+WS server.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const paths = resolvePaths(opts.home);
  ensureHome(paths);
  requireNoHostRemoval(paths.home);
  const config = loadConfig(paths);
  const authority = new LeaseRegistry();
  const admission = new HostAdmission();
  const upkeep = new HostBackgroundTasks();
  let updateCoordinator: HostUpdateCoordinator | null = null;
  let remoteUpdates: RemoteHostUpdates | null = null;
  let releaseCollection: ReleaseCollectionMaintenance | null = null;
  let observedTerminalUpdate = '';
  let announceHostUpdates = () => {};
  const executeHostUpdate = async (
    command: HostUpdateCommand,
    authorised: () => boolean,
  ): Promise<HostUpdateReply> => {
    const result = await (updateCoordinator?.execute(command, authorised) ??
      Promise.resolve({ ok: false as const, code: 'unavailable' as const, operation: null }));
    if (command.action !== 'status') announceHostUpdates();
    const operation = result.operation;
    if (operation && hostUpdateTerminal(operation.phase)) {
      const identity = `${operation.id}:${operation.revision}`;
      if (identity !== observedTerminalUpdate) {
        observedTerminalUpdate = identity;
        releaseCollection?.request();
      }
    }
    return result;
  };
  let controlInfo: {
    port: number;
    version: { version: string; protocol: typeof PROTOCOL_VERSION };
  } | null = null;
  const failedStartup: Array<() => void | Promise<void>> = [];
  let cleanupFailed = false;
  try {
    const closeControl = await startHostControl(
      paths.home,
      authority,
      () => controlInfo,
      executeHostUpdate,
      {
        check: (profile, claim) => remoteMaintenanceAuthority(paths.home, profile, claim),
        execute: (command, authorised) => {
          if (!remoteUpdates) throw new Error('Host maintenance is unavailable');
          return remoteUpdates.execute(command, authorised);
        },
      },
    );
    failedStartup.push(closeControl);
    requireNoHostRemoval(paths.home);
    ensureToken(paths);
    const db = openDatabase(paths.dbFile);
    failedStartup.push(async () => {
      // A failed drain does not prove its callbacks stopped using SQLite.
      if (cleanupFailed) return;
      await upkeep.close();
      db.close();
    });

    const profiles = new ProfileStore(db);
    const accounts = new AccountStore(db);
    const repos = new RepoStore(db);
    const projects = new ProjectStore(db);
    const profileStates = new ProfileStateStore(db);
    const removals = new RemovalStore(db);
    const scratchpad = new ScratchpadStore(db);
    const layouts = new LayoutStore(db);
    const sessions = new SessionStore(db);
    const runtimes = new RuntimeStore(db);
    const conversations = new ConversationStore(db);
    const events = new EventStore(db);
    // The last frontend report seeds new owners and converges adopted ones.
    const terminalTheme = new TerminalTheme(() => runtimeReconciler.refreshThemes());
    const runtimeReconciler = new RuntimeReconciler({
      home: paths.home,
      db,
      runtimes,
      sessions,
      conversations,
      events,
      captureEnabled: (profileId) => profiles.getSettings(profileId).captureSessionEnv,
      theme: () => terminalTheme.colours(),
    });
    profiles.onCaptureChanged = (id) => runtimeReconciler.refreshProfile(id);
    const runtimeConnections = new RuntimeConnections(
      paths.home,
      runtimes,
      {
        connected: (id, client) => runtimeReconciler.attach(id, client),
        missing: (id) => runtimeReconciler.retire(id),
      },
      await acquireRuntimeControllerWhenAvailable(paths.home),
    );
    failedStartup.push(() => runtimeConnections.close());
    failedStartup.push(() => runtimeReconciler.close());
    const runtimeTerminals = new RuntimeTerminals(
      paths.home,
      runtimes,
      runtimeConnections,
      runtimeReconciler.observations,
    );
    const bootSwitches: SessionSwitchEvent[] = [];
    const captureBootSwitch = (event: SessionSwitchEvent) => {
      if (event.outcome === 'rebound' && event.cause !== 'resume') bootSwitches.push(event);
    };
    runtimeReconciler.on('session-switched', captureBootSwitch);
    await runtimeConnections.connect();
    const runtimeControls = new RuntimeControls(runtimes, runtimeConnections, runtimeReconciler);
    failedStartup.push(() => runtimeControls.close());
    const runtimeLauncher =
      opts.runtime !== false
        ? new RuntimeLauncher(
            {
              home: paths.home,
              environment: Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              runtimes,
              sessions,
              projects,
              profiles,
              connections: runtimeConnections,
              reconciler: runtimeReconciler,
              theme: () => terminalTheme.colours(),
            },
            opts.runtime ?? { installed: true },
          )
        : undefined;
    if (runtimeLauncher) failedStartup.push(() => runtimeLauncher.close());
    const compilationSettings = new CompilationSettingsStore(db);

    const storagePaths = [paths.home, paths.logsDir, paths.worktreesDir, tmpdir()];
    const storage = new StorageMonitor(() => [
      ...storagePaths,
      ...repos.list().map((repo) => repo.path),
      ...sessions
        .list()
        .filter((session) => ['starting', 'running', 'waiting_input'].includes(session.status))
        .map((session) => session.worktree_path),
      ...accounts.list().map((account) => account.config_dir),
    ]);
    // A write to an existing metadata page tests SQLite recovery without replaying
    // any failed user operation or allocating a separate probe database.
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    storage.setDatabaseProbe(() => {
      db.pragma(`user_version = ${schemaVersion}`);
    });
    void storage.refresh().catch((error: unknown) => console.warn('Storage check failed:', error));
    storage.start();
    failedStartup.push(() => storage.dispose());
    const logs = new LogStore(paths.logsDir, config.replayBytes, config.logMaxBytes, (degraded) =>
      storage.setLogsDegraded(degraded),
    );
    // Clients report their resolved terminal colours over the WS (14.1); the
    // PTY layer answers agents' OSC 10/11 colour queries from the last report.
    const ptys = new PtyManager(logs, terminalTheme, paths.logsDir, (degraded) =>
      storage.setLogsDegraded(degraded, 'screens'),
    );
    const shellHooks = installShellHooks(paths);
    failedStartup.push(() => {
      ptys.killAll();
      logs.closeAll();
    });
    const scanner = new PortScanner({
      ptys,
      external: new RuntimeProcesses(runtimes, runtimeConnections),
    });
    const worktrees = new WorktreeManager({
      runtimes,
      paths,
      storage,
      mutex: new KeyedMutex(),
      repos,
      sessions,
    });
    const latex = new LatexProvider({ sessions, repos });
    const notebooks = new NotebookKernels({ sessions, repos });
    failedStartup.push(() => notebooks.dispose());
    const onboarding = new MarkerFileSync({ repos, events, sessions, storage });
    failedStartup.push(() => onboarding.dispose());
    const adapters = new AdapterRegistry(opts.adapters ?? defaultAdapters);
    // Migration 004 rewrote config-dir paths to id-keyed; rename the dirs before
    // adapters install watches or inspect any native conversation store.
    reconcileProfileDirs(profiles.list(), paths);
    const accountObservations = new AccountObservations({
      accounts,
      adapters,
      ptys,
      background: upkeep,
    });
    failedStartup.push(() => accountObservations.close());
    const share = new ConversationShare({
      accounts,
      adapters,
      paths,
      mutex: new KeyedMutex(),
      events,
    });
    const service = new SessionService({
      runtimes,
      runtimeControls,
      runtimeLauncher,
      runtimeTerminalAgent: (id) => runtimeTerminals.detectedAgent(id),
      runtimeShellHooks: (id) => readRuntimeShellHooks(runtimeDirectory(paths.home, id)),
      runtimePriorRefs: (id) => runtimePriorRefs(paths.home, runtimes, id),
      runtimeSwitchSettled: async (id) => {
        await runtimeReconciler.refresh(id);
        const client = runtimeConnections.get(id);
        if (!client || runtimeReconciler.pendingIds().includes(id)) return false;
        // The state cached before bind-placement still names the old segment.
        // Read the owner's acknowledged binding before starting another owner.
        const reply = await client.request({ t: 'inspect' });
        const current = runtimes.get(id);
        return (
          reply.t === 'state' &&
          !!current &&
          reply.state.binding?.session_id === current.active_session_id &&
          reply.state.binding.segment_id === current.active_segment_id
        );
      },
      runtimeProgrammeTurns: new RuntimeProgrammeTurns(
        runtimes,
        runtimeConnections,
        runtimeReconciler,
        new ProgrammeTurnStore(db),
      ),
      storage,
      storagePaths,
      profiles,
      accounts,
      repos,
      projects,
      sessions,
      conversations,
      events,
      worktrees,
      ptys,
      adapters,
      logs,
      onboarding,
      share,
      shellHooks,
      statusQuietMs: opts.statusQuietMs,
    });
    runtimeReconciler.on('changed', (projectId: string) =>
      service.emit('sessions-changed', { projectIds: [projectId] }),
    );
    runtimeReconciler.off('session-switched', captureBootSwitch);
    runtimeReconciler.on('session-switched', (event) => service.emit('session-switched', event));
    runtimeReconciler.on('status', (event) => service.emit('status', event));
    runtimeConnections.on('disconnected', (id: string) => {
      const owner = runtimes.get(id);
      if (owner) service.emit('sessions-changed', { projectIds: [owner.project_id] });
    });
    const compilation = new CompilationService(
      [
        latex,
        ...createCodeProviders({
          sessions,
          repos,
          notebooks,
          runtimes,
          launchTerminal: createCodeTerminalLauncher({
            sessions,
            repos,
            projects,
            service,
            ptys,
            runtimes,
            runtimeReconciler,
          }),
        }),
      ],
      { settings: compilationSettings, projects, profiles },
    );
    failedStartup.push(() => compilation.dispose());
    const puddlang = new PuddlangService(new PuddlangStore(db), {
      profiles,
      accounts,
      projects,
      repos,
      adapters,
      service,
      worktrees,
    });
    failedStartup.push(() => puddlang.dispose());
    const updateInspection = new HostUpdateInspection({
      connector: new HostUpdateConnector(paths.home),
      compatibility: new HostUpdateCompatibility({
        home: paths.home,
        current: hostReleaseCapabilities(opts.version ?? '0.0.0', DATABASE_SCHEMA_VERSION),
        databaseSchemaVersion: () => db.pragma('user_version', { simple: true }) as number,
        runtimes,
        connections: runtimeConnections,
      }),
      impact: new HostUpdateImpact({
        controller: randomUUID(),
        ptys,
        notebooks,
        compilation,
        puddlang,
      }),
      capacity: new HostUpdateCapacity(paths, storage),
      supervision: new HostUpdateSupervision({ home: paths.home, pid: process.pid }),
    });
    const updateAdoption = new HostUpdateAdoptionWriter({
      home: paths.home,
      db,
      runtimes,
      connections: runtimeConnections,
      reconciler: runtimeReconciler,
      version: opts.version ?? '0.0.0',
      nodePath: process.execPath,
      entryPath: fileURLToPath(import.meta.url),
      port: () => controlInfo?.port ?? null,
    });
    const stopPush = subscribePushNotifications(paths.home, service, {
      profiles,
      projects,
      sessions,
    });
    failedStartup.push(stopPush);
    const catalogue = new ConversationCatalogue({
      accounts,
      conversations,
      projects,
      repos,
      sessions,
      adapters,
      worktrees,
    });

    catalogue.on(
      'background-conversation',
      (event: { accountId: number; conversationId: number }) => {
        void service
          .attachBackground(event.accountId, event.conversationId)
          .catch((error: unknown) => {
            service.emit('notice', {
              level: 'warning',
              title: 'Native fork could not attach',
              detail:
                'The original conversation and native copy are preserved. ' +
                ((error as { code?: string })?.code === 'runtime_provider_unsupported' &&
                error instanceof Error
                  ? error.message
                  : 'Inspect the copy before resuming it explicitly.'),
            });
          });
      },
    );

    failedStartup.push(async () => {
      service.beginShutdown();
      await catalogue.dispose();
      await service.drainObservations();
    });

    accountObservations.refresh();

    // Repair the shared conversation store's symlinks (missing/dangling) so
    // every account of a profile can still resolve its adopted conversations.
    upkeep.start('conversation-reconcile', () => share.reconcile());

    const sweptStates = profileStates.gc(config.uiStateRetentionDays);
    if (sweptStates > 0) console.log(`ui-state gc: ${sweptStates} stale row(s) removed`);

    const reconciled = reconcilePass({ sessions, events, projects, onboarding, runtimes });
    if (reconciled.interrupted.length > 0) {
      console.log(`reconcile: ${reconciled.interrupted.length} session(s) marked interrupted`);
    }
    if (reconciled.protected.length > 0) {
      console.log(
        `reconcile: ${reconciled.protected.length} placement(s) retain independent runtime ownership; ${runtimeConnections.unavailableIds().length} owner(s) unavailable; ${runtimeReconciler.pendingIds().length} reconciliation(s) pending`,
      );
    }

    // Periodic fetch for repos with at least one non-archived session (SPEC §4).
    const fetchTimer = setInterval(
      () => {
        upkeep.startBatch('repository-fetch', repos.list(), async (repo) => {
          if (!repo.fetch_enabled || sessions.listActiveByRepo(repo.id).length === 0) return;
          await worktrees.fetchRepo(repo);
        });
      },
      config.fetchIntervalMinutes * 60 * 1000,
    );
    fetchTimer.unref();
    failedStartup.push(() => clearInterval(fetchTimer));

    const tracker = new ProxySocketTracker();
    const gateway = new WsGateway({
      admission,
      runtimeTerminals,
      profileAccess: new ProfileAccess({ profiles, projects, sessions }),
      authority,
      ptys,
      logs,
      service,
      catalogue,
      theme: terminalTheme,
    });
    // Login verification lands after the login PTY exits, when no request is in
    // flight to carry it — the push is what turns the accounts UI green (15.1).
    accounts.onLoggedInChanged = (account) => gateway.accountChanged(account);
    const app = buildApp({
      version: opts.version ?? '0.0.0',
      authority,
      admission,
      api: {
        storage,
        paths,
        profiles,
        accounts,
        repos,
        projects,
        profileStates,
        removals,
        scratchpad,
        layouts,
        sessions,
        catalogue,
        adapters,
        ptys,
        worktrees,
        service,
        share,
        scanner,
        tracker,
        compilation,
        notebooks,
        latex,
        puddlang,
      },
      ws: { gateway, upgradeWebSocket },
    });

    const wss = new WebSocketServer({ noServer: true });
    // createAdaptorServer builds the server WITHOUT listening, so we own the bind
    // and can fall back off a busy port (listenWithFallback) instead of crashing.
    const server: ServerType = createAdaptorServer({
      fetch: app.fetch,
      websocket: { server: wss },
    });
    failedStartup.push(() => {
      wss.close();
      server.close();
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    const port = await listenWithFallback(server, opts.port ?? config.port, '127.0.0.1');
    // Record where we actually bound so clients (and a returning `puddle launch`)
    // can find us even when the preferred port was taken.
    controlInfo = {
      port,
      version: { version: opts.version ?? '0.0.0', protocol: PROTOCOL_VERSION },
    };
    writeRuntime(paths, { port, pid: process.pid });
    // Agent spawns from here on carry the /agent-signal env pair (SPEC §4).
    service.setSignalPort(port);
    const runtimeNotifications = new RuntimeNotifications({
      store: runtimeReconciler.attention,
      runtimes,
      sessions,
      reconciler: runtimeReconciler,
      ready: (id) =>
        runtimeReconciler.settled(id) &&
        (!!runtimeConnections.get(id) ||
          !['prepared', 'running'].includes(runtimes.get(id)?.state ?? '')),
      content: (session, row) =>
        notificationContent(
          session,
          row.attention.reason,
          { ptys, adapters, accounts },
          runtimeTerminals.notificationOutput(session.id, row.attention.id),
        ),
      emit: (event) => service.emit('agent-notification', event),
    });
    failedStartup.push(() => runtimeNotifications.close());
    const runtimeServiceCleanup = new RuntimeServiceCleanup({
      home: paths.home,
      store: new RuntimeServiceCleanupStore(db),
      reconciler: runtimeReconciler,
    });
    failedStartup.push(() => runtimeServiceCleanup.close());

    // Auto-resume is ON by default (SPEC §4; flipped 2026-08-09) — a daemon
    // restart brings interrupted sessions straight back; any that fail surface
    // in the UI for one-click resume. Runs AFTER the bind on purpose, so
    // auto-resumed agents get the signal env too.
    for (const event of bootSwitches) service.emit('session-switched', event);
    bootSwitches.length = 0;
    if (config.autoResume) {
      for (const id of new Set([...reconciled.interrupted, ...runtimeReconciler.autoResumeIds()])) {
        await service
          .resume(id)
          .catch((e) => console.warn(`auto-resume ${id} failed: ${e.message}`));
      }
    }

    // Register the tier-2 proxy's raw WebSocket upgrade listener AFTER serve() so
    // it becomes the SECOND 'upgrade' listener — see attachProxyUpgrade for why
    // that ordering is load-bearing. /ws stays with @hono/node-server's own listener.
    const detachProxy = attachProxyUpgrade(server as import('node:http').Server, {
      sessions,
      scanner,
      authority,
      tracker,
    });

    const retention = new LogRetention(() => {
      const current = readConfig(paths);
      return {
        logsDir: paths.logsDir,
        retentionDays: current.logRetentionDays,
        // The live LogStore keeps its boot-time replay window until restart.
        replayBytes: Math.max(config.replayBytes, current.replayBytes),
        isBusy: (stream, term) => ptys.has(stream, term) || logs.isOpen(stream, term),
      };
    });
    retention.start();
    failedStartup.push(() => retention.dispose());

    announceHostUpdates = () => gateway.hostUpdatesChanged();
    const releaseChecks = new HostReleaseChecks({ home: paths.home, changed: announceHostUpdates });
    failedStartup.push(() => releaseChecks.close());
    const pauseDaemon = daemonUpdatePause({
      clients: admission,
      upkeep,
      retention,
      programmes: puddlang,
      compilation,
      catalogue,
      markers: onboarding,
      launcher: runtimeLauncher,
      sessions: service,
      controls: runtimeControls,
      notebooks,
      notifications: runtimeNotifications,
      cleanup: runtimeServiceCleanup,
      connections: runtimeConnections,
      reconciler: runtimeReconciler,
      refreshAccounts: () => accountObservations.refresh(),
    });
    updateCoordinator = new HostUpdateCoordinator({
      home: paths.home,
      operations: new HostUpdateOperations(paths.home),
      catalogue: () =>
        hostUpdateCatalogue({
          home: paths.home,
          version: opts.version ?? '0.0.0',
          runtimes,
          connections: runtimeConnections,
          releases: releaseChecks,
        }),
      inspection: updateInspection,
      pauseDaemon,
      observeAdoption: (operation, nonce) => {
        updateAdoption.observe(operation, nonce);
      },
      continueRecovery: async (operation, authorised) => {
        await startUpdateRecoveryWorker(paths.home, operation, {
          authorised,
          releasePath: dirname(dirname(fileURLToPath(import.meta.url))),
        });
      },
      installedRuntime: () => {
        try {
          return resolveInstalledRuntimeRelease(paths.home).protocol;
        } catch {
          return null;
        }
      },
      dispatch: async (operation, kind, authorised, daemon) => {
        await startUpdateWorker(paths.home, operation, {
          kind,
          authorised,
          daemon,
          releasePath: dirname(dirname(fileURLToPath(import.meta.url))),
        });
      },
    });
    failedStartup.push(() => updateCoordinator?.close());
    remoteUpdates = new RemoteHostUpdates({
      version: opts.version ?? '0.0.0',
      execute: executeHostUpdate,
      stage: (repository, target, authorised) =>
        stageRemoteHostUpdate(
          paths.home,
          dirname(dirname(fileURLToPath(import.meta.url))),
          repository,
          target,
          authorised,
        ),
    });
    // This task pauses upkeep, so it must own its schedule outside that admission.
    releaseCollection = new ReleaseCollectionMaintenance({
      home: paths.home,
      runtimes,
      pause: pauseDaemon,
      controller: () => runtimeConnections.controllerIdentity(),
      reclaimResults: () => runtimeReconciler.observations.reclaimResults(),
      retireRuntimeResults: (id) => runtimeReconciler.retireResultReservations(id),
      runtimeLogs: new RuntimeLogRetention({
        home: paths.home,
        runtimes,
        retentionDays: () => readConfig(paths).logRetentionDays,
      }),
    });
    failedStartup.push(() => releaseCollection!.close());

    let stopping: Promise<void> | null = null;
    let shutdownUpdate: string | undefined;
    return {
      port,
      authority,
      paths,
      service,
      updateInspection,
      admission,
      stop(update) {
        let updateKey =
          update && `${update.operation_id}:${update.dispatch_id}:${update.preflight}`;
        if (stopping) {
          if (update && updateKey !== shutdownUpdate)
            return Promise.reject(new Error('Daemon is already stopping for another reason'));
          return stopping;
        }
        let checkpoint: HostUpdateCheckpointWriter | undefined;
        try {
          update ??=
            pendingDaemonUpdateShutdown(paths.home, runtimeConnections.controllerIdentity()) ??
            undefined;
          updateKey = update && `${update.operation_id}:${update.dispatch_id}:${update.preflight}`;
          if (update)
            checkpoint = new HostUpdateCheckpointWriter(
              { home: paths.home, db, runtimes, version: opts.version ?? '0.0.0' },
              update,
            );
        } catch (error) {
          return Promise.reject(error);
        }
        shutdownUpdate = updateKey;
        // Close admission synchronously, before any asynchronous cleanup yields.
        admission.close();
        upkeep.beginShutdown();
        accountObservations.close();
        clearInterval(fetchTimer);
        updateCoordinator?.close();
        releaseChecks.close();
        const collectionClosed = releaseCollection!.close();
        // A request already preparing a launch must not create another child
        // after cleanup has taken its inventory of daemon-owned terminals.
        ptys.beginShutdown();
        service.beginShutdown();
        stopping = (async () => {
          await collectionClosed;
          await runtimeLauncher?.close();
          runtimeNotifications.close();
          await runtimeServiceCleanup.close();
          await retention.dispose();
          storage.dispose();
          await puddlang.dispose();
          stopPush();
          controlInfo = null;
          authority.dispose();
          await closeControl();
          await catalogue.dispose();
          compilation.dispose();
          await notebooks.dispose();
          onboarding.dispose();
          await runtimeControls.close();
          await runtimeReconciler.close();
          // Disposing execution managers settles their outstanding HTTP calls.
          // Finish admitted handlers before closing terminal state or SQLite;
          // closing a socket alone does not cancel its asynchronous handler.
          await admission.drain();
          await service.drainObservations();
          await upkeep.close();
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
          await ptys.closeTerminalStates();
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
          // After the socket is closed, not before: the file's presence means "up",
          // so a reader mid-shutdown probes a dead port (→ restart), never a live
          // one it then mis-trusts.
          clearRuntime(paths);
          // Release control only after application writers and servers have
          // stopped. External owners, PTYs and journals survive this detach.
          // A failed discovery drain can still have callbacks using SQLite.
          // Retain both the controller claim and database until process exit;
          // a timeout is not proof that those callbacks have stopped.
          await runtimeConnections.close(
            checkpoint && ((controller) => checkpoint.commit(controller)),
          );
          db.close();
        })();
        return stopping;
      },
    };
  } catch (err) {
    admission.close();
    upkeep.beginShutdown();
    controlInfo = null;
    authority.dispose();
    for (const cleanup of failedStartup.reverse()) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
        /* Preserve the startup failure. */
      }
    }
    throw err;
  }
}

/**
 * Bind `server` to `preferredPort`, falling back to an OS-assigned free port if
 * it is already in use — the bind IS the selection, so there is no check-then-
 * bind race. Only EADDRINUSE falls back: EACCES (a misconfigured privileged
 * port) and every other error propagate, since those are configuration faults,
 * not contention. A `preferredPort` of 0 already means "any free port".
 */
function listenWithFallback(
  server: ServerType,
  preferredPort: number,
  hostname: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let triedFallback = false;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !triedFallback && preferredPort !== 0) {
        triedFallback = true;
        console.warn(`port ${preferredPort} is in use — binding a free port instead`);
        server.listen(0, hostname); // retry; onError stays attached for a second failure
        return;
      }
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : preferredPort);
    };
    server.on('error', onError);
    server.once('listening', onListening);
    server.listen(preferredPort, hostname);
  });
}
