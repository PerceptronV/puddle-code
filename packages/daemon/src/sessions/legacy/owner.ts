import type { SessionEnvironment } from '../environment.js';
import type { RuntimePersistence } from '../../storage/runtime-persistence.js';
import { storageUnavailable } from '../../storage/monitor.js';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type {
  Account,
  AgentNotification,
  AgentTurnSignal,
  Session,
  SessionStatus,
} from '@puddle/shared';
import type { AgentAdapter, LaunchOpts, LifecycleLaunchResource } from '../../agents/adapter.js';
import { AgentLaunchError } from '../../agents/launch-error.js';
import { ApiError } from '../../http/errors.js';
import { extractOscTitle, stripAnsi } from '../../pty/ansi.js';
import type {
  PtyCwdEvent,
  PtyDataEvent,
  PtyEnvDeltaEvent,
  PtyExitEvent,
} from '../../pty/pty-manager.js';
import { StatusDetector, type DetectedStatus } from '../../pty/status-detector.js';
import { terminalCommandArgs, type TerminalCommand } from '../terminal-command.js';
import type { SessionIdentity } from '../identity.js';
import { TerminalAgentMonitor } from '../terminal-agent-monitor.js';
import { notificationContent } from '../notification-content.js';
import type {
  LifecycleSignal,
  NoticeEvent,
  RenameEvent,
  SessionServiceDeps,
  SessionSwitchEvent,
  StatusEvent,
} from '../service.js';

interface LiveAgent {
  /** Stable identity for the process tree, independent of its active placement. */
  runtimeId: string;
  activeSessionId: string;
  conversationId: number | null;
  lifecycleResource: LifecycleLaunchResource | null;
  /** Null for terminal sessions — a plain shell has no status detector. */
  detector: StatusDetector | null;
  /** When this PTY was spawned, to tell a failed launch from a later crash. */
  startedAt: number;
  status: Extract<SessionStatus, 'starting' | 'running' | 'waiting_input'>;
  lastTouch: number;
  /** Throttle for the OSC-title-driven agent-name re-read (see onPtyData). */
  lastTitleCheck: number;
  /** Last OSC "sequence" title seen, to persist/broadcast only on a real change. */
  lastOscTitle: string | null;
  /** Per-spawn secret for /agent-signal (SPEC §4); null for shells. */
  signalNonce: string | null;
  /**
   * True once a hook signal arrived: from then on the agent's own hooks are
   * authoritative for running ⇄ waiting_input and the regex detector is
   * ignored (TUI redraws would otherwise flap an idle session back to
   * running with no hook event to restore it).
   */
  signalled: boolean;
}

const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

// How often to re-read each live agent's own session name. A rename made INSIDE
// the agent (e.g. Claude Code's `/rename`) is a client-side transcript edit that
// triggers no status change and — while the session sits idle — no terminal-title
// escape either, so the event-driven refreshes (status change, OSC title, exit)
// all miss it. Cheap per tick: adapter.sessionTitle is a cached stat that
// early-returns while the transcript's (size, mtime) are unchanged.
const TITLE_REFRESH_MS = 3000;

// A `running` agent whose transcript has been quiet this long is flagged
// `stale_running` (computed on read, like worktree_missing) — probably a
// wedged agent process. Advisory only: a genuinely long tool call looks the
// same, so the daemon must never kill or downgrade the session itself.
const STALE_RUNNING_MS = 60 * 60 * 1000;

// An agent dying this soon after spawn failed to START — a rejected flag, a
// missing credential — rather than crashing mid-work. The status is no use for
// telling these apart: a launch error printed to the terminal is output like
// any other, so it flips the session to `running` on its way out.
const STARTUP_FAILURE_MS = 5000;
type LegacyDeps = Pick<
  SessionServiceDeps,
  | 'sessions'
  | 'accounts'
  | 'adapters'
  | 'projects'
  | 'conversations'
  | 'events'
  | 'ptys'
  | 'logs'
  | 'runtimes'
  | 'storage'
  | 'onboarding'
  | 'statusQuietMs'
  | 'titleRefreshMs'
>;
interface PlacementHooks {
  transition(id: string, status: SessionStatus): void;
  assertLegacyRuntime(id: string): void;
  runLifecycle<T>(work: () => Promise<T>): Promise<T>;
  emit: EventEmitter['emit'];
}

/** Own daemon-hosted PTYs, signals, detectors and their stable runtime indexes. */
export class LegacySessionOwner {
  private readonly liveAgents = new Map<string, LiveAgent>();

  /** nonce → session id for /agent-signal lookups; entries die with the PTY. */
  private readonly signalNonces = new Map<string, LiveAgent>();

  /** Stable runtime registry and the one-live-runtime-per-conversation index. */
  private readonly runtimes = new Map<string, LiveAgent>();

  private readonly conversationRuntimes = new Map<number, LiveAgent>();

  /** The daemon's bound port, once known — enables the signal env injection. */
  private signalPort: number | null = null;

  /**
   * Streams (or `${stream}:${term}` pairs) being stopped on purpose, so their
   * non-zero exit raises no notice. Entries are consumed by the matching exit.
   */
  private readonly expectedExits = new Set<string>();

  private observationsPaused = false;

  private readonly titleTimer: ReturnType<typeof setInterval>;

  private readonly terminalAgents: TerminalAgentMonitor;

  private lastPersistenceRetry = 0;
  private shuttingDown = false;
  constructor(
    private readonly deps: LegacyDeps,
    private readonly environment: SessionEnvironment,
    private readonly identity: SessionIdentity,
    private readonly persistence: RuntimePersistence,
    private readonly hooks: PlacementHooks,
  ) {
    this.terminalAgents = new TerminalAgentMonitor({
      adapters: deps.adapters.list(),
      quietMs: deps.statusQuietMs,
      notify: (session, reason) =>
        this.persistence.observe(() => this.notifyAgent(session, reason)),
      targets: () =>
        [...this.liveAgents.values()].flatMap((live) => {
          if (live.detector !== null) return [];
          const pid = deps.ptys.pidFor(live.activeSessionId, 'agent');
          return pid === null
            ? []
            : [{ session: live.activeSessionId, runtime: live.runtimeId, pid }];
        }),
      changed: (id) => {
        this.hooks.emit('sessions-changed', { projectIds: [deps.sessions.get(id).project_id] });
      },
    });
    deps.ptys.on('data', (e: PtyDataEvent) => this.persistence.observe(() => this.onPtyData(e)));
    deps.ptys.on('exit', (e: PtyExitEvent) => this.persistence.observe(() => this.onPtyExit(e)));
    deps.ptys.on('input', (e: { stream: string; term: string }) => {
      if (e.term === 'agent') this.liveAgents.get(e.stream)?.lifecycleResource?.control?.input?.();
    });
    deps.ptys.on('env-delta', (e: PtyEnvDeltaEvent) =>
      this.persistence.observe(() => {
        if (!this.shuttingDown) this.environment.onEnvDelta(e);
      }),
    );
    deps.ptys.on('cwd', (e: PtyCwdEvent) =>
      this.persistence.observe(() => {
        if (!this.shuttingDown) this.environment.onCwd(e);
      }),
    );
    // Catch in-agent renames that emit no signal (see TITLE_REFRESH_MS). Unref'd
    // so it never keeps the process (or a test run) alive.
    this.titleTimer = setInterval(() => {
      if (this.observationsPaused) return;
      if (Date.now() - this.lastPersistenceRetry >= 30_000) {
        this.lastPersistenceRetry = Date.now();
        const saved = this.persistence.retry();
        if (saved.length)
          this.hooks.emit('sessions-changed', {
            projectIds: [...new Set(saved.map((id) => deps.sessions.get(id).project_id))],
          });
      }
      for (const id of this.liveAgents.keys())
        this.persistence.observe(() => this.identity.refreshAgentIdentity(id));
    }, this.deps.titleRefreshMs ?? TITLE_REFRESH_MS);
    this.titleTimer.unref?.();
  }
  beginShutdown(): void {
    this.shuttingDown = true;
    clearInterval(this.titleTimer);
    this.terminalAgents.dispose();
  }
  pauseObservations(): () => void {
    this.observationsPaused = true;
    return () => {
      this.observationsPaused = false;
    };
  }
  /** Stop only daemon-owned processes; independent ownership is checked at entry. */
  async kill(id: string): Promise<void> {
    this.hooks.assertLegacyRuntime(id);
    const session = this.deps.sessions.get(id);
    this.expectExit(id); // asked for: its non-zero exit raises no notice
    this.deps.ptys.killAll(id);
    const deadline = Date.now() + 4000;
    let escalated = false;
    while (this.deps.ptys.liveTerms(id).length > 0) {
      if (Date.now() > deadline + 2000)
        throw new ApiError(500, 'kill_failed', 'session PTYs refused to die');
      if (!escalated && Date.now() > deadline) {
        this.deps.ptys.killAll(id, 'SIGKILL');
        escalated = true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (LIVE_STATUSES.includes(session.status)) {
      // The exit handler normally does this; cover the no-PTY edge.
      if (this.deps.sessions.get(id).status !== 'exited') this.hooks.transition(id, 'exited');
    }
  }

  spawnShell(sessionId: string, cwd: string): string {
    this.hooks.assertLegacyRuntime(sessionId);
    const used = new Set([
      ...this.deps.logs.listTerms(sessionId),
      ...this.deps.ptys.liveTerms(sessionId),
    ]);
    let n = 1;
    while (used.has(`shell-${n}`)) n++;
    const term = `shell-${n}`;
    const { shell, args, env } = this.environment.shellSpawnParts(sessionId);
    // A second shell opens where the session lives, matching its first one.
    this.deps.ptys.spawn(sessionId, term, shell, args, { cwd, env });
    return term;
  }

  get liveCount(): number {
    return this.liveAgents.size;
  }
  runtime(id: string) {
    return this.runtimes.get(id);
  }
  session(id: string) {
    return this.liveAgents.get(id);
  }
  conversation(id: number) {
    return this.conversationRuntimes.get(id);
  }
  terminalAgent(id: string): string | null | undefined {
    const live = this.liveAgents.get(id);
    return live ? this.terminalAgents.get(id, live.runtimeId) : undefined;
  }

  spawnTerminal(sessionId: string, worktreePath: string, command?: TerminalCommand): void {
    this.hooks.assertLegacyRuntime(sessionId);
    const { shell, args, env } = this.environment.shellSpawnParts(sessionId);
    try {
      this.deps.runtimes?.useLegacyTerminals(sessionId);
      this.deps.ptys.spawn(
        sessionId,
        'agent',
        command ? '/bin/sh' : shell,
        command ? terminalCommandArgs(command, shell, args) : args,
        { cwd: command?.cwd ?? worktreePath, env: { ...env, ...command?.env } },
      );
    } catch (e) {
      this.hooks.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(500, 'spawn_failed', `could not start ${shell}: ${(e as Error).message}`);
    }
    const live: LiveAgent = {
      runtimeId: randomUUID(),
      activeSessionId: sessionId,
      conversationId: null,
      lifecycleResource: null,
      detector: null,
      startedAt: Date.now(),
      status: 'starting',
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
      signalNonce: null,
      signalled: false,
    };
    this.liveAgents.set(sessionId, live);
    this.runtimes.set(live.runtimeId, live);
  }

  async spawnAgent(
    sessionId: string,
    worktreePath: string,
    account: Account,
    adapter: AgentAdapter,
    args: string[],
    initial: LiveAgent['status'],
    launchOpts?: LaunchOpts,
    resumeRef?: string,
    beforeSpawn?: () => void,
  ): Promise<void> {
    this.hooks.assertLegacyRuntime(sessionId);
    // The status-signal side-channel (SPEC §4): a per-spawn nonce plus the
    // daemon's own /agent-signal URL, injected so agent hook processes (which
    // inherit this env) can report running ⇄ waiting_input authoritatively.
    const signalNonce = this.signalPort !== null ? randomUUID() : null;
    // A fresh agent is never an expected exit — clear any flag a previous
    // kill left behind so this run's crash is reported.
    this.expectedExits.delete(sessionId);
    let lifecycleResource: LifecycleLaunchResource | null = null;
    let spawnArgs = args;
    let nativeSync: NonNullable<Session['native_sync']> = 'fallback';
    let lifecycleUnavailable = false;
    const headless = this.deps.sessions.get(sessionId).agent_mode === 'headless';
    if (headless && (signalNonce === null || !adapter.prepareHeadlessLaunch)) {
      this.hooks.transition(sessionId, 'exited');
      throw ApiError.conflict(
        'headless_mode_unavailable',
        'Headless execution requires an adapter control channel',
      );
    }
    if (signalNonce !== null && this.signalPort !== null) {
      const prepare = headless ? adapter.prepareHeadlessLaunch : adapter.prepareLifecycleLaunch;
      if (prepare) {
        try {
          lifecycleResource = await prepare({
            account,
            reportLifecycleUnavailable: () => {
              lifecycleUnavailable = true;
            },
            opts: launchOpts ?? {
              worktreePath,
              sessionId,
              skipPermissions: this.deps.sessions.get(sessionId).skip_permissions,
            },
            args,
            signalUrl: `http://127.0.0.1:${this.signalPort}/agent-signal`,
            signalNonce,
            resumeRef,
            env: this.environment.capturedSpawnEnv(this.deps.sessions.get(sessionId)),
            writeInput: (data) => {
              const live = this.signalNonces.get(signalNonce);
              if (!live) throw new Error('Agent terminal is no longer live');
              this.deps.ptys.write(live.activeSessionId, 'agent', data, 'script');
            },
            reportStatus: (state) => {
              this.signalAgentStatus(signalNonce, state);
            },
            bindConversation: async (ref) => {
              const accepted = await this.signalAgentLifecycle({
                nonce: signalNonce,
                event: 'session_start',
                agent_session_ref: ref,
                cwd: worktreePath,
                source: resumeRef ? 'resume' : 'startup',
              });
              if (!accepted)
                throw new Error('Agent runtime ended before its conversation was bound');
            },
          });
          spawnArgs = lifecycleResource.args;
          nativeSync = lifecycleUnavailable ? 'fallback' : 'full';
        } catch (error) {
          if (headless || error instanceof AgentLaunchError) {
            this.hooks.transition(sessionId, 'exited');
            this.deps.events.record(sessionId, 'spawn_failed', { message: String(error) });
            throw ApiError.conflict(
              headless ? 'headless_mode_unavailable' : 'agent_launch_failed',
              String(error),
            );
          }
          console.warn(
            `${adapter.displayName} lifecycle bridge unavailable: ${(error as Error).message}`,
          );
        }
      } else if (adapter.lifecycleSignals) {
        try {
          nativeSync =
            (await adapter.checkLifecycleSupport?.(account)) === false ? 'fallback' : 'full';
        } catch (error) {
          console.warn(
            `${adapter.displayName} lifecycle capability check failed: ${(error as Error).message}`,
          );
        }
      }
    }
    try {
      beforeSpawn?.();
      this.hooks.assertLegacyRuntime(sessionId);
      this.deps.runtimes?.useLegacyTerminals(sessionId);
      this.deps.ptys.spawn(
        sessionId,
        'agent',
        lifecycleResource?.binary ?? adapter.binary,
        spawnArgs,
        {
          cwd: worktreePath,
          // Adapter env is sacrosanct (e.g. CLAUDE_CONFIG_DIR) — it wins over
          // captured vars; process.env is merged underneath by PtyManager.
          env: {
            ...this.environment.capturedSpawnEnv(this.deps.sessions.get(sessionId)),
            ...adapter.env(account),
            ...(signalNonce !== null
              ? {
                  PUDDLE_AGENT_SIGNAL_URL: `http://127.0.0.1:${this.signalPort}/agent-signal`,
                  PUDDLE_AGENT_SIGNAL_NONCE: signalNonce,
                }
              : {}),
          },
        },
      );
    } catch (e) {
      await lifecycleResource?.dispose();
      if (
        e instanceof ApiError &&
        ['runtime_reconciliation_required', 'native_source_changed'].includes(e.code)
      )
        throw e;
      this.hooks.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(
        500,
        'spawn_failed',
        `could not start ${adapter.binary}: ${(e as Error).message}`,
      );
    }
    // Detector callbacks follow the stable runtime's current placement. A
    // closure over the spawn-time session id would silently stop status
    // updates after a native switch for regex-driven agents.
    let live: LiveAgent | null = null;
    const detector = new StatusDetector(
      adapter.statusPatterns,
      {
        onStatus: (s) =>
          this.persistence.observe(() => this.onDetected(live?.activeSessionId ?? sessionId, s)),
        onLimitReached: () =>
          this.persistence.observe(() =>
            this.deps.events.record(live?.activeSessionId ?? sessionId, 'limit_reached'),
          ),
      },
      this.deps.statusQuietMs ?? 2000,
    );
    const current = this.deps.sessions.get(sessionId);
    live = {
      runtimeId: randomUUID(),
      activeSessionId: sessionId,
      conversationId: current.conversation_id ?? null,
      lifecycleResource,
      detector,
      startedAt: Date.now(),
      status: initial,
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
      signalNonce,
      signalled: false,
    };
    this.liveAgents.set(sessionId, live);
    this.runtimes.set(live.runtimeId, live);
    if (live.conversationId !== null) this.conversationRuntimes.set(live.conversationId, live);
    if (signalNonce !== null) this.signalNonces.set(signalNonce, live);
    if (lifecycleResource?.sidecarPids?.length || lifecycleResource?.hiddenPorts?.length) {
      this.deps.ptys.registerSidecars(
        sessionId,
        lifecycleResource.sidecarPids ?? [],
        lifecycleResource.hiddenPorts ?? [],
      );
    }
    this.deps.sessions.setNativeSync(sessionId, nativeSync);
    if (nativeSync === 'fallback' && signalNonce !== null) {
      this.hooks.emit('notice', {
        level: 'warning',
        title: 'Conversation switching is not synchronised',
        detail: `${adapter.displayName} will keep running, but in-agent conversation switches will stay in this terminal tab.`,
        session: sessionId,
      } satisfies NoticeEvent);
    }
  }

  private onPtyData(e: PtyDataEvent): void {
    if (this.shuttingDown) return;
    const live = this.liveAgents.get(e.stream);
    if (!live) return;
    const now = Date.now();
    if (now - live.lastTouch > 1000) {
      live.lastTouch = now;
      this.persistence.observe(() =>
        this.deps.sessions.touchActivity(e.stream, new Date(now).toISOString()),
      );
    }
    if (e.term !== 'agent') return;
    if (live.status === 'starting') {
      live.status = 'running';
      this.observeTransition(e.stream, 'running');
    }
    live.detector?.feed(e.data);
    if (live.detector === null) this.terminalAgents.feed(e.stream, e.data);
    // A session announces a name change by setting its terminal title (OSC
    // 0/1/2) — e.g. Claude Code's `/rename`, handled client-side with no status
    // transition. `extractOscTitle` returns the de-animated title (spinner
    // glyphs stripped) or null (SPEC §4).
    const oscTitle = extractOscTitle(e.data);
    if (oscTitle !== null) {
      // The "sequence" name: the default label for sessions without an
      // adapter-maintained agent_title (terminals, agents whose adapter has no
      // sessionTitle). Persist only on a real change — already de-animated.
      if (oscTitle !== live.lastOscTitle) {
        live.lastOscTitle = oscTitle;
        this.captureOscTitle(e.stream, oscTitle);
      }
      // For an adapter that keeps its own name (Claude Code → transcript), the
      // title emission is the cue to re-read it; throttled, transcript wins.
      if (now - live.lastTitleCheck > 1000) {
        live.lastTitleCheck = now;
        this.identity.refreshAgentIdentity(e.stream);
      }
    }
  }

  /**
   * Stores the terminal-title "sequence" name and broadcasts a `renamed` so an
   * attached client's default label tracks it live. A user `title` and an
   * adapter's `agent_title` both still win in the display order (SPEC §4).
   * Best-effort: never throws upward.
   */
  private captureOscTitle(sessionId: string, oscTitle: string): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    if ((session.osc_title ?? null) === oscTitle) return; // already current
    this.deps.sessions.setOscTitle(sessionId, oscTitle);
    this.hooks.emit('renamed', {
      session: sessionId,
      title: session.title,
      agent_title: session.agent_title ?? null,
      osc_title: oscTitle,
    } satisfies RenameEvent);
  }

  /**
   * The daemon's bound port, learnt after listen — from then on every agent
   * spawn carries the /agent-signal env pair (see spawnAgent).
   */
  setSignalPort(port: number): void {
    this.signalPort = port;
  }

  /** This session's live signal nonce (tests/diagnostics), or null. */
  signalNonceFor(sessionId: string): string | null {
    return this.liveAgents.get(sessionId)?.signalNonce ?? null;
  }

  /**
   * POST /agent-signal (SPEC §4): an agent hook reports its own state. The
   * nonce is the auth — unknown or stale (PTY exited) → false, and the route
   * 404s without leaking whether the nonce ever existed. The first signal
   * flips the session to hooks-are-authoritative (see LiveAgent.signalled).
   */
  signalAgentStatus(nonce: string, state: 'working' | 'waiting_input'): boolean {
    if (this.shuttingDown) return false;
    const live = this.signalNonces.get(nonce);
    if (!live || !this.runtimes.has(live.runtimeId)) return false;
    const sessionId = live.activeSessionId;
    live.signalled = true;
    this.onDetected(sessionId, state === 'working' ? 'running' : 'waiting_input', 'signal');
    return true;
  }

  signalAgentTurn(signal: AgentTurnSignal): boolean {
    if (this.shuttingDown) return false;
    const live = this.signalNonces.get(signal.nonce);
    if (!live || !this.runtimes.has(live.runtimeId) || !live.lifecycleResource?.control?.signal)
      return false;
    const state = live.lifecycleResource.control.signal(signal);
    if (state) this.signalAgentStatus(signal.nonce, state);
    return true;
  }

  /**
   * Consume an exact top-level native lifecycle event. Compact and initial
   * startup only refresh identity; clear/resume/fork may atomically move the
   * stable runtime to another immutable Puddle placement.
   */
  async signalAgentLifecycle(signal: LifecycleSignal): Promise<boolean> {
    if (this.shuttingDown) return false;
    const runtime = this.signalNonces.get(signal.nonce);
    if (!runtime || !this.runtimes.has(runtime.runtimeId)) return false;
    const apply = async () => {
      if (!this.runtimes.has(runtime.runtimeId)) return false;
      if (this.deps.storage?.status().database_degraded) throw storageUnavailable();
      const sourceId = runtime.activeSessionId;
      const source = this.deps.sessions.get(sourceId);
      if (
        signal.event === 'session_end' &&
        signal.agent_session_ref !== undefined &&
        signal.agent_session_ref !== source.agent_session_ref
      )
        return true;
      runtime.lifecycleResource?.control?.lifecycle?.(
        signal.agent_session_ref,
        signal.event === 'session_end',
      );
      if (signal.event === 'session_end') {
        this.deps.events.record(sourceId, 'native_session_end', {
          source: signal.source,
          ref: signal.agent_session_ref ?? source.agent_session_ref,
        });
        return true;
      }
      if (!signal.agent_session_ref || source.account_id === null || source.agent_type === null) {
        return true;
      }
      const account = this.deps.accounts.get(source.account_id);
      const project = this.deps.projects.get(source.project_id);
      const parentRef =
        signal.parent_agent_session_ref ??
        (signal.source === 'fork' ? (source.agent_session_ref ?? undefined) : undefined);
      const conversation = this.deps.conversations.upsert(
        project.profile_id,
        source.agent_type,
        account.id,
        {
          ref: signal.agent_session_ref,
          cwd: signal.cwd,
          ...(signal.native_title !== undefined ? { title: signal.native_title } : {}),
          ...(parentRef !== undefined ? { parentRef } : {}),
          ...(signal.native_created_at !== undefined
            ? { createdAt: signal.native_created_at }
            : {}),
          ...(signal.native_updated_at !== undefined
            ? { updatedAt: signal.native_updated_at }
            : {}),
        },
      );
      // An exact event proves which account currently owns the native
      // conversation, unlike catalogue polling of a profile-shared store.
      this.deps.conversations.setPreferredAccount(conversation.id, account.id);

      const sameConversation = source.conversation_id === conversation.id;
      if (signal.source === 'compact' || sameConversation) {
        if (!sameConversation && source.conversation_id == null) {
          this.deps.sessions.setConversation(sourceId, conversation.id);
        }
        this.bindRuntimeConversation(sourceId);
        this.deps.sessions.setNativeSync(sourceId, 'full');
        return true;
      }
      if (!['clear', 'resume', 'fork'].includes(signal.source)) {
        if (source.conversation_id == null) {
          this.deps.sessions.setConversation(sourceId, conversation.id);
          this.bindRuntimeConversation(sourceId);
        }
        this.deps.sessions.setNativeSync(sourceId, 'full');
        return true;
      }

      const cause = signal.source as SessionSwitchEvent['cause'];
      const existingRuntime = this.conversationRuntimes.get(conversation.id);
      if (existingRuntime && existingRuntime !== runtime) {
        const target = this.deps.sessions.get(existingRuntime.activeSessionId);
        this.expectExit(sourceId);
        this.deps.ptys.killAll(sourceId);
        if (LIVE_STATUSES.includes(source.status)) this.hooks.transition(sourceId, 'exited');
        this.deps.events.record(sourceId, 'native_switch_conflict', {
          cause,
          target_session: target.id,
          target_project: target.project_id,
        });
        this.hooks.emit('session-switched', {
          sourceSession: sourceId,
          targetSession: target.id,
          targetProject: target.project_id,
          cause,
          outcome: 'focused-existing',
        } satisfies SessionSwitchEvent);
        return true;
      }

      const canonicalPath = this.deps.sessions.canonicalWorktreePath(sourceId);
      let targetId = this.deps.conversations.placement(
        conversation.id,
        source.project_id,
        canonicalPath,
      );
      if (targetId === null) {
        targetId = randomUUID();
        this.deps.sessions.create({
          id: targetId,
          project_id: source.project_id,
          account_id: source.account_id,
          conversation_id: conversation.id,
          worktree_path: source.worktree_path,
          base_branch: source.base_branch,
          branch: source.branch,
          separate_branch: source.separate_branch,
          branch_owned: false,
          kind: 'agent',
          agent_type: source.agent_type,
          title: null,
          status: 'exited',
          native_sync: 'full',
          skip_permissions: source.skip_permissions,
        });
      }
      if (targetId === sourceId) {
        this.bindRuntimeConversation(sourceId);
        return true;
      }

      this.deps.sessions.adoptRuntimeState(sourceId, targetId);
      this.deps.sessions.transferBranchOwnership(sourceId, targetId);
      this.liveAgents.delete(sourceId);
      this.liveAgents.set(targetId, runtime);
      runtime.activeSessionId = targetId;
      if (runtime.conversationId !== null) {
        const indexed = this.conversationRuntimes.get(runtime.conversationId);
        if (indexed === runtime) this.conversationRuntimes.delete(runtime.conversationId);
      }
      runtime.conversationId = conversation.id;
      this.conversationRuntimes.set(conversation.id, runtime);
      try {
        await this.deps.ptys.rebindStream(sourceId, targetId);
      } catch (error) {
        this.liveAgents.delete(targetId);
        this.liveAgents.set(sourceId, runtime);
        runtime.activeSessionId = sourceId;
        throw error;
      }
      this.deps.onboarding.unwatch(sourceId);
      this.identity.forget(sourceId);
      this.hooks.transition(sourceId, 'exited');
      const runtimeStillLive = this.runtimes.has(runtime.runtimeId);
      if (runtimeStillLive) this.hooks.transition(targetId, runtime.status);
      this.deps.onboarding.watch(targetId, project.repo_id, source.worktree_path);
      if (runtimeStillLive) this.deps.ptys.redraw(targetId, 'agent');
      this.deps.events.record(sourceId, 'native_switched_away', {
        cause,
        target_session: targetId,
        conversation_id: conversation.id,
      });
      this.deps.events.record(targetId, 'native_switched_to', {
        cause,
        source_session: sourceId,
        conversation_id: conversation.id,
      });
      this.hooks.emit('session-switched', {
        sourceSession: sourceId,
        targetSession: targetId,
        targetProject: source.project_id,
        cause,
        outcome: 'rebound',
      } satisfies SessionSwitchEvent);
      return true;
    };
    return this.hooks.runLifecycle(apply);
  }

  bindRuntimeConversation(sessionId: string): void {
    const runtime = this.liveAgents.get(sessionId);
    if (!runtime) return;
    const conversationId = this.deps.sessions.get(sessionId).conversation_id ?? null;
    if (runtime.conversationId !== null && runtime.conversationId !== conversationId) {
      const indexed = this.conversationRuntimes.get(runtime.conversationId);
      if (indexed === runtime) this.conversationRuntimes.delete(runtime.conversationId);
    }
    runtime.conversationId = conversationId;
    if (conversationId === null) return;
    const existing = this.conversationRuntimes.get(conversationId);
    if (existing && existing !== runtime) {
      this.hooks.emit('notice', {
        level: 'warning',
        title: 'Conversation already running',
        detail: 'A duplicate runtime was stopped to keep native conversation ownership unique.',
        session: sessionId,
      } satisfies NoticeEvent);
      this.expectExit(sessionId);
      this.deps.ptys.killAll(sessionId);
      return;
    }
    this.conversationRuntimes.set(conversationId, runtime);
  }

  private onDetected(
    sessionId: string,
    detected: DetectedStatus,
    source: 'detector' | 'signal' = 'detector',
  ): void {
    const live = this.liveAgents.get(sessionId);
    if (!live || live.status === detected) return;
    // Regex output cannot establish an idle state before the PTY has produced
    // its first chunk. An authoritative hook can: Claude's first Stop hook may
    // beat its first visible TUI draw, and dropping it leaves the session amber
    // until another hook happens to fire.
    if (live.status === 'starting' && source === 'detector') return;
    // Once hooks have spoken, the regex detector no longer drives status —
    // its output-based flips misread idle TUI redraws as activity.
    if (source === 'detector' && live.signalled) return;
    live.status = detected;
    this.observeTransition(sessionId, detected);
    // Backstop for adoption: by waiting_input the agent has written its
    // conversation file, which was usually absent at spawn time.
    if (detected === 'waiting_input') {
      this.identity.scheduleAdopt(sessionId);
      this.notifyAgent(sessionId, 'waiting_input');
    }
    // The agent's own name lands in (and updates within) the transcript as the
    // conversation progresses; pick it up on each status change.
    this.identity.refreshAgentIdentity(sessionId);
  }

  private onPtyExit(e: PtyExitEvent): void {
    const live = this.liveAgents.get(e.stream);
    // Shells have no agent state to tear down, but a shell dying on its own is
    // still something the user should hear about.
    if (e.term !== 'agent') {
      this.noticeOnAbnormalExit(e, false);
      return;
    }
    if (!live) return;
    const startupFailure = Date.now() - live.startedAt < STARTUP_FAILURE_MS;
    live.detector?.dispose();
    if (live.signalNonce !== null) this.signalNonces.delete(live.signalNonce);
    this.deps.ptys.unregisterSidecars(e.stream);
    void live.lifecycleResource?.dispose();
    this.runtimes.delete(live.runtimeId);
    if (
      live.conversationId !== null &&
      this.conversationRuntimes.get(live.conversationId) === live
    ) {
      this.conversationRuntimes.delete(live.conversationId);
    }
    this.liveAgents.delete(e.stream);
    if (this.shuttingDown) return; // reconcile turns these into `interrupted` next boot
    const expected =
      this.expectedExits.has(e.stream) || this.expectedExits.has(`${e.stream}:agent`);
    if (!expected) {
      if (live.detector === null) this.terminalAgents.exited(e.stream);
      else this.notifyAgent(e.stream, 'exited');
    }
    this.observeTransition(e.stream, 'exited', e.exitCode);
    this.terminalAgents.forget(e.stream);
    this.identity.refreshAgentIdentity(e.stream); // capture the final ref/name for the durable row
    this.noticeOnAbnormalExit(e, startupFailure);
    this.expectedExits.delete(e.stream);
    this.expectedExits.delete(`${e.stream}:agent`);
  }

  /**
   * Turns an unexpected non-zero exit into a user-visible notice (SPEC §4).
   * Errors used to be silent here: a bad flag or a failed auth killed the
   * process in milliseconds, and unless the user happened to be looking at
   * that exact terminal they saw nothing at all.
   *
   * Deliberately quiet for exits we asked for (kill, archive, delete, shell
   * close, shutdown) and for clean ones — a notice the user learns to ignore
   * is worse than no notice.
   */
  private noticeOnAbnormalExit(e: PtyExitEvent, startupFailure: boolean): void {
    if (this.shuttingDown || e.exitCode === 0) return;
    if (this.expectedExits.delete(`${e.stream}:${e.term}`)) return;
    // A whole-session stop covers every term, so the flag is consumed by the
    // agent's exit rather than the first shell's — otherwise it would linger
    // and silence a genuine crash after the next resume.
    if (this.expectedExits.has(e.stream)) {
      if (e.term === 'agent') this.expectedExits.delete(e.stream);
      return;
    }
    const label = e.term === 'agent' ? 'Agent' : 'Terminal';
    this.hooks.emit('notice', {
      level: 'error',
      title: startupFailure
        ? `${label} failed to start (exit ${e.exitCode})`
        : `${label} exited unexpectedly (exit ${e.exitCode})`,
      detail: this.exitDetail(e),
      session: e.stream,
      term: e.term,
    } satisfies NoticeEvent);
  }

  /** The last few lines the process printed — usually the whole diagnosis. */
  private exitDetail(e: PtyExitEvent): string | undefined {
    let tail: string;
    try {
      tail = stripAnsi(this.deps.logs.readTail(e.stream, e.term));
    } catch {
      return undefined;
    }
    const lines = tail
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '');
    if (lines.length === 0) return undefined;
    return lines.slice(-4).join('\n').slice(-400);
  }

  /**
   * Marks a stream (or one term of it) as being stopped on purpose, so its
   * exit does not raise a notice. Cleared by the matching exit.
   */
  expectExit(stream: string, term?: string): void {
    this.expectedExits.add(term === undefined ? stream : `${stream}:${term}`);
  }

  private notifyAgent(session: string, reason: AgentNotification['reason']): void {
    if (this.shuttingDown) return;
    this.persistence.observe(() => this.identity.refreshAgentTitle(session));
    const event: AgentNotification = {
      t: 'agent-notification',
      id: randomUUID(),
      session,
      reason,
    };
    const placement = this.deps.sessions.get(session);
    void notificationContent(placement, reason, this.deps)
      .then((content) => {
        if (!this.shuttingDown)
          this.hooks.emit('agent-notification', { ...event, content } satisfies AgentNotification);
      })
      .catch(() => {
        if (!this.shuttingDown) this.hooks.emit('agent-notification', event);
      });
  }

  private observeTransition(id: string, status: SessionStatus, exitCode?: number): void {
    this.persistence.save(id, { status, ...(exitCode !== undefined ? { exitCode } : {}) });
    const s = this.deps.sessions.get(id);
    this.hooks.emit('status', {
      session: id,
      status,
      last_activity_at: s.last_activity_at,
    } satisfies StatusEvent);
  }

  /** See STALE_RUNNING_MS. Best-effort: any failure reads as "not stale". */
  staleRunning(session: Session): boolean {
    if (
      session.status !== 'running' ||
      session.kind !== 'agent' ||
      !session.agent_session_ref ||
      session.account_id === null ||
      !this.liveAgents.has(session.id)
    )
      return false;
    try {
      const account = this.deps.accounts.get(session.account_id);
      const adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
      const activityAt = adapter.sessionActivityAt?.(session.agent_session_ref, account);
      return activityAt !== null && activityAt !== undefined
        ? Date.now() - activityAt.getTime() > STALE_RUNNING_MS
        : false;
    } catch {
      return false;
    }
  }
}
