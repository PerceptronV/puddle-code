import type {
  Account,
  AgentSignalRequest,
  AgentTurnSignal,
  ClearSessionEnvResponse,
  CreateSessionRequest,
  RestartSessionRuntimeRequest,
  Session,
  SessionEnvResponse,
  SessionRuntimeInspection,
  SessionStatus,
} from '@puddle/shared';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentAdapter, LaunchOpts } from '../agents/adapter.js';
import { assertBinaryAvailable } from '../agents/binary.js';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { ConversationStore } from '../db/stores/conversations.js';
import type { EventStore } from '../db/stores/events.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { RuntimeStore } from '../db/stores/runtimes.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { KeyedMutex } from '../git/mutex.js';
import { HostAdmission } from '../host/lifecycle/admission.js';
import { ApiError } from '../http/errors.js';
import { containedPath } from '../http/routes/worktrees/worktree-shared.js';
import type { LogStore } from '../logs/log-store.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { ShellHooks } from '../pty/shell-hooks.js';
import type { ProgrammeOperation } from '../puddlang/runtime-turn-store.js';
import type { RuntimeControls } from '../runtime/controller/controls.js';
import type { RuntimeProgrammeTurns } from '../runtime/controller/programme-turns.js';
import type { RuntimeLauncher, RuntimeLaunchGuard } from '../runtime/lifecycle/launcher.js';
import type { StorageMonitor } from '../storage/monitor.js';
import { RuntimePersistence } from '../storage/runtime-persistence.js';
import type { CreateWorktreeResult, WorktreeManager } from '../worktrees/manager.js';
import type { ConversationShare } from './conversation-share.js';
import { SessionEnvironment } from './environment.js';
import { buildHandoffPrompt } from './handoff.js';
import { SessionIdentity } from './identity.js';
import { LegacySessionOwner } from './legacy/owner.js';
import { migrateSessionAccount } from './migration/service.js';
import type { MarkerFileSync } from './onboarding.js';
import {
  buildConcurrentWorktreeNote,
  buildInterruptedResumeNote,
  buildOnboardingPreamble,
} from './onboarding.js';
import { SessionRuntimeService } from './runtime/service.js';
import { terminalCommandArgs, type TerminalCommand } from './terminal-command.js';

export interface SessionServiceDeps {
  storage?: StorageMonitor;
  storagePaths?: string[];
  profiles: ProfileStore;
  accounts: AccountStore;
  repos: RepoStore;
  projects: ProjectStore;
  sessions: SessionStore;
  /** Durable external ownership must never fall through to in-process controls. */
  runtimes?: RuntimeStore;
  runtimeControls?: RuntimeControls;
  runtimeLauncher?: RuntimeLauncher;
  runtimeShellHooks?: (runtimeId: string) => ShellHooks | null;
  runtimePriorRefs?: (sessionId: string) => ReadonlySet<string> | undefined;
  runtimeProgrammeTurns?: RuntimeProgrammeTurns;
  runtimeTerminalAgent?: (sessionId: string) => string | null;
  conversations: ConversationStore;
  events: EventStore;
  worktrees: WorktreeManager;
  ptys: PtyManager;
  adapters: AdapterRegistry;
  logs: LogStore;
  onboarding: MarkerFileSync;
  /** Shared conversation store (Workstream S); absent → no adoption. */
  share?: ConversationShare;
  /** Session shell hooks (SPEC §4); absent → no cwd hook, history still isolated via env. */
  shellHooks?: ShellHooks;
  /** waiting_input quiet window; overridable for tests. */
  statusQuietMs?: number;
  /** Periodic agent-name re-read interval; overridable for tests. */
  titleRefreshMs?: number;
}

export interface StatusEvent {
  session: string;
  status: SessionStatus;
  last_activity_at: string | null;
}

/** A failure the user must see, relayed to every client as a toast (SPEC §4). */
export interface NoticeEvent {
  level: 'error' | 'warning';
  title: string;
  detail?: string;
  session?: string;
  term?: string;
}

export interface RenameEvent {
  session: string;
  /** User override (null → use agent_title, then osc_title, then the id prefix). */
  title: string | null;
  /** The agent's own name; carried so a live agent-title change updates the default. */
  agent_title: string | null;
  /** The terminal-title "sequence" name; carried so a live change updates the default. */
  osc_title?: string | null;
}

export type LifecycleSignal = Extract<
  AgentSignalRequest,
  { event: 'session_start' | 'session_end' }
>;

export interface SessionSwitchEvent {
  sourceSession: string;
  targetSession: string;
  targetProject: string;
  cause: 'clear' | 'resume' | 'fork';
  outcome: 'rebound' | 'focused-existing';
}

const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

/**
 * Orchestrates the session state machine (SPEC §4). SQLite rows are the
 * durable truth; LegacySessionOwner owns daemon-hosted processes and the
 * independent launcher owns new persistent runtimes. Emits 'status' (StatusEvent) and
 * 'renamed' (RenameEvent).
 */
export class SessionService extends EventEmitter {
  /** Resolve current placement through stable runtime ownership for puddlang. */
  scriptRuntime(reference: string) {
    const external = this.deps.runtimeProgrammeTurns?.inspect(reference);
    if (external) return { ...external, session: this.get(external.handle.session_id) };
    const live = this.legacy.runtime(reference) ?? this.legacy.session(reference);
    if (!live) throw ApiError.conflict('agent_not_live', 'The agent has no live runtime');
    const control = live.lifecycleResource?.control;
    if (!control)
      throw ApiError.conflict(
        'scripted_turns_unavailable',
        'This runtime has no exact automated-turn channel; use a supported agent with full native synchronisation',
      );
    return {
      handle: { runtime_id: live.runtimeId, session_id: live.activeSessionId },
      session: this.get(live.activeSessionId),
      ready: control.ready,
    };
  }

  scriptAsk(
    reference: string,
    prompt: string,
    signal: AbortSignal,
    schema?: Record<string, unknown>,
    scope?: ProgrammeOperation,
    preserveOnAbort?: () => boolean,
    dispatched?: () => void,
  ): Promise<string> {
    const runtime = this.scriptRuntime(reference);
    const live = this.legacy.runtime(runtime.handle.runtime_id);
    if (live?.lifecycleResource?.control)
      return live.lifecycleResource.control.ask(prompt, signal, schema);
    if (!scope || !this.deps.runtimeProgrammeTurns)
      throw new Error('An independent runtime ask requires durable programme identity');
    return this.deps.runtimeProgrammeTurns.ask(
      runtime.handle.runtime_id,
      scope,
      prompt,
      signal,
      schema,
      preserveOnAbort,
      dispatched,
    );
  }

  /** Stop only the programme's recorded owner, never a replacement in its old placement. */
  async stopScriptRuntime(id: string, profile: string): Promise<void> {
    const owner = this.deps.runtimes?.get(id);
    if (owner) {
      if (owner.profile_id !== profile)
        throw new ApiError(403, 'profile_scope', 'Runtime belongs to another profile');
      if (owner.state === 'exited') return;
      if (!['prepared', 'running'].includes(owner.state) || !this.deps.runtimeControls)
        throw ApiError.conflict(
          'runtime_stop_unconfirmed',
          'Runtime descendant cleanup is unconfirmed',
        );
      const sessionId = owner.active_session_id;
      await this.deps.runtimeControls.stop(
        sessionId,
        () =>
          this.deps.runtimes?.ownerOf(sessionId)?.runtime_id === id &&
          this.deps.runtimes.get(id)?.profile_id === profile,
      );
      return;
    }
    const live = this.legacy.runtime(id);
    if (!live) return;
    const sessionId = live.activeSessionId;
    await this.kill(
      sessionId,
      () =>
        this.legacy.runtime(id) === live &&
        live.activeSessionId === sessionId &&
        this.deps.projects.get(this.get(sessionId).project_id).profile_id === profile,
    );
  }
  private readonly lifecycleMutex = new KeyedMutex();
  private readonly lifecycleAdmission = new HostAdmission();
  private readonly launchBackend:
    { kind: 'independent'; launcher: RuntimeLauncher } | { kind: 'legacy' };
  private readonly legacy: LegacySessionOwner;
  private readonly environment: SessionEnvironment;
  private readonly identity: SessionIdentity;
  private shuttingDown = false;
  private readonly persistence: RuntimePersistence;

  private readonly runtimeMaintenance: SessionRuntimeService;

  constructor(private readonly deps: SessionServiceDeps) {
    super();
    this.launchBackend = deps.runtimeLauncher
      ? { kind: 'independent', launcher: deps.runtimeLauncher }
      : { kind: 'legacy' };
    this.runtimeMaintenance = new SessionRuntimeService(
      deps,
      (id, guard) => this.resumeCore(id, guard),
      (account, adapter) => this.assertLoggedIn(account, adapter),
    );
    this.environment = new SessionEnvironment(deps);
    this.persistence = new RuntimePersistence(deps.sessions, deps.events, deps.storage);
    this.identity = new SessionIdentity(
      deps,
      this.persistence,
      (id) => this.legacy.bindRuntimeConversation(id),
      (event) => this.emit('renamed', event),
    );
    this.legacy = new LegacySessionOwner(deps, this.environment, this.identity, this.persistence, {
      transition: (id, status) => this.transition(id, status),
      assertLegacyRuntime: (id) => this.assertLegacyRuntime(id),
      runLifecycle: (work) =>
        this.lifecycleAdmission.run(() =>
          this.lifecycleMutex.run('native-conversation-switch', work),
        ),
      emit: (event, ...args) => this.emit(event, ...args),
    });
  }

  /**
   * Daemon shutdown: PTYs are about to be killed, but their sessions must
   * KEEP their live status rows — the next boot's reconcile pass turns them
   * into `interrupted` (SPEC §4). Without this, the exit handlers would
   * record a graceful `exited` and the restart AT would lie.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.lifecycleAdmission.close();
    this.identity.beginShutdown();
    this.legacy.beginShutdown();
  }

  /** Drain native capture before pausing the shared-store adoption it can trigger. */
  pause(): ReturnType<HostAdmission['pause']> {
    // Legacy agents have no independent journal for identity events during a pause.
    // Their first upgrade still uses the explicitly interrupting migration path.
    if (this.legacy.liveCount)
      throw new ApiError(
        503,
        'host_maintenance',
        'Daemon-owned agents require an interrupting upgrade.',
      );
    const refs = this.identity.pauseCapture();
    let lifecycle: ReturnType<HostAdmission['pause']>;
    try {
      lifecycle = this.lifecycleAdmission.pause();
    } catch (error) {
      refs.release();
      throw error;
    }
    const resumeObservations = this.legacy.pauseObservations();
    let adoption: ReturnType<HostAdmission['pause']> | undefined;
    let released = false;
    return {
      drain: async (timeoutMs = 30_000) => {
        const deadline = performance.now() + timeoutMs;
        await refs.drain(timeoutMs);
        await lifecycle.drain(deadline - performance.now());
        if (released || this.shuttingDown)
          throw new Error('Native observation pause ended before drainage');
        adoption ??= this.identity.pauseAdoption();
        await adoption.drain(deadline - performance.now());
      },
      release: () => {
        if (released) return;
        released = true;
        adoption?.release();
        lifecycle.release();
        refs.release();
        resumeObservations();
      },
    };
  }

  /** Await native identity/switch and shared-store observations admitted before shutdown. */
  async drainObservations(): Promise<void> {
    this.beginShutdown();
    await Promise.all([this.identity.drain(), this.lifecycleAdmission.drain()]);
  }

  get(id: string): Session {
    return this.withComputed(this.deps.sessions.get(id));
  }

  /** Removed as each control is routed through the adopted external backend. */
  assertLegacyRuntime(id: string): void {
    if (this.deps.runtimes?.ownerOf(id)) {
      throw ApiError.conflict(
        'runtime_reconciliation_required',
        'This placement has an independent runtime awaiting reconciliation; its work has not been stopped.',
      );
    }
  }

  list(
    filter: { project_id?: string; profile_id?: string; status?: SessionStatus } = {},
  ): Session[] {
    return this.deps.sessions
      .list({ ...filter, status: undefined })
      .map((s) => this.withComputed(s))
      .filter((s) => filter.status === undefined || s.status === filter.status);
  }

  /**
   * Renames the puddle session only — the git branch is untouched (SPEC §6).
   * An empty title CLEARS the user override, so the display name reverts to the
   * agent's own name (`agent_title`), then the terminal-title name (`osc_title`),
   * then the session-id prefix.
   */
  rename(id: string, title: string): Session {
    this.deps.sessions.get(id);
    const trimmed = title.trim();
    this.deps.sessions.setTitle(id, trimmed === '' ? null : trimmed);
    const session = this.get(id);
    this.emit('renamed', {
      session: id,
      title: session.title,
      agent_title: session.agent_title ?? null,
      osc_title: session.osc_title ?? null,
    } satisfies RenameEvent);
    return session;
  }

  async create(
    input: CreateSessionRequest,
    agentMode: NonNullable<Session['agent_mode']> = 'interactive',
    programme?: ProgrammeOperation,
  ): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    const profile = this.deps.profiles.get(project.profile_id);
    const repo = this.deps.repos.get(project.repo_id);
    await this.deps.storage?.assertAdmission([...(this.deps.storagePaths ?? []), repo.path]);

    // A terminal session has no account/agent — it forks off into its own path
    // (a shell in the worktree, no onboarding, no conversation — SPEC §4).
    if ((input.kind ?? 'agent') === 'terminal') {
      if (agentMode === 'headless')
        throw ApiError.badRequest('agent_mode', 'Terminal placements cannot use headless mode');
      return this.createTerminal(input, project, profile, repo);
    }
    if (input.cwd !== undefined) {
      throw ApiError.badRequest('cwd_terminal_only', 'cwd applies to terminal sessions only');
    }
    if (input.account_id === undefined) {
      throw ApiError.badRequest('account_required', 'an agent session needs an account_id');
    }
    const account = this.deps.accounts.get(input.account_id);
    await this.deps.storage?.assertAdmission([account.config_dir]);
    if (account.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'foreign_account',
        'the account does not belong to this project’s profile',
      );
    }
    const adapter = this.deps.adapters.get(account.agent_type);
    if (agentMode === 'headless' && !adapter.prepareHeadlessLaunch)
      throw ApiError.badRequest(
        'agent_mode',
        `${adapter.displayName} does not support headless mode`,
      );
    assertBinaryAvailable(adapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(account, adapter);

    // Permissions gate (SPEC §11): create REJECTS a denied request outright.
    const skip = this.evaluateSkip(project.profile_id, account, adapter, input.skip_permissions);
    if (input.skip_permissions === true && !skip) {
      throw ApiError.badRequest(
        'skip_permissions_denied',
        'skip_permissions requires the profile gate and the account opt-in',
      );
    }

    const separateBranch = input.separate_branch !== false;
    const separateWorktree = input.separate_worktree !== false; // agents: own dir by default
    const sessionId = randomUUID();
    const worktree = await this.resolveSessionWorktree({
      repo,
      profile,
      sessionId,
      input,
      separateBranch,
      separateWorktree,
    });
    await this.deps.storage?.assertAdmission([worktree.worktreePath]);
    const session = this.deps.sessions.create(
      {
        id: sessionId,
        project_id: project.id,
        account_id: account.id,
        worktree_path: worktree.worktreePath,
        base_branch: worktree.baseBranch,
        branch: worktree.branch,
        separate_branch: separateBranch,
        branch_owned: worktree.created,
        kind: 'agent',
        agent_type: account.agent_type,
        agent_mode: agentMode,
        title: input.title ?? null,
        skip_permissions: skip,
      },
      this.deps.runtimeLauncher ? programme : undefined,
    );

    // Every freshly created worktree onboards — and only those (SPEC §4).
    // Attaching to an existing shared worktree is a reuse, like a hand-off:
    // the environment already exists, so no onboarding — but other agents may
    // be working in that same directory, so the prompt carries a concurrency
    // heads-up rather than going in bare. The launch text is the profile's
    // template (Settings → Sessions), falling back to the built-in default.
    const settings = this.deps.profiles.getSettings(project.profile_id);
    const preamble = worktree.created
      ? buildOnboardingPreamble(
          settings.onboardingTemplate,
          repo.onboarding_notes,
          input.prompt ?? null,
        )
      : buildConcurrentWorktreeNote(settings.concurrentTemplate, input.prompt ?? null);
    const launchOpts = {
      worktreePath: worktree.worktreePath,
      sessionId,
      // A cleared template with no task prompt means no initial prompt at all.
      prompt: preamble === '' ? undefined : preamble,
      skipPermissions: skip,
    };
    const spawn = () =>
      this.spawnAgent(
        sessionId,
        worktree.worktreePath,
        account,
        adapter,
        adapter.launchArgs(launchOpts),
        'starting',
        launchOpts,
        undefined,
        programme,
      );
    if (agentMode === 'headless' || this.launchBackend.kind === 'independent') await spawn();
    else
      await this.identity.refs.launchAndCapture(
        session,
        account,
        adapter,
        launchOpts,
        spawn,
        () => this.identity.refreshAgentIdentity(sessionId),
        (error, phase) => {
          // Minted-id launches run after the HTTP response has returned, so no
          // request remains to carry an unexpected spawn/capture failure.
          const detail = (error as Error).message;
          console.warn(`agent ${phase} ${sessionId} failed: ${detail}`);
          if (phase === 'spawn') {
            this.emit('notice', {
              level: 'error',
              title: `${adapter.displayName} failed to start`,
              detail,
              session: sessionId,
              term: 'agent',
            } satisfies NoticeEvent);
          }
        },
      );
    this.legacy.bindRuntimeConversation(sessionId);
    // Adopt-after-first-write: the conversation file rarely exists this early,
    // so this is a best-effort first attempt; the waiting_input flip retries.
    this.identity.scheduleAdopt(sessionId);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      account_id: account.id,
      skip_permissions: skip,
      separate_branch: separateBranch,
      branch_owned: worktree.created,
      worktree_created: worktree.created,
    });
    // Only the worktree's creator watches its .puddle/ markers: in a shared
    // worktree, concurrent watchers would race to claim `session-title`.
    if (worktree.created) this.deps.onboarding.watch(sessionId, repo.id, worktree.worktreePath);
    this.deps.projects.touch(project.id);
    return this.get(session.id);
  }

  /**
   * A terminal session (SPEC §4): a plain shell PTY in a worktree, with no
   * account, no agent, and no onboarding. Unlike agent sessions it defaults to
   * the shared base-branch worktree (`separate_branch` off) — a scratch shell
   * usually wants the branch as-is, not a fresh one. There is no conversation
   * to adopt and no `.puddle/` markers to watch.
   */
  /**
   * Picks the worktree a new session lands in from the two independent axes
   * (SPEC §4): `separate_branch` (a fresh branch in its own worktree, vs. the
   * base branch) and `separate_worktree` (its own directory, vs. sharing one).
   * A separate branch always gets its own directory; only a base-branch session
   * may share. `join_session` shares a specific existing session's directory;
   * otherwise sharing uses the base branch's canonical shared worktree. Shared
   * by both the agent and terminal create paths.
   */
  private async resolveSessionWorktree(opts: {
    repo: ReturnType<RepoStore['get']>;
    profile: ReturnType<ProfileStore['get']>;
    sessionId: string;
    input: CreateSessionRequest;
    separateBranch: boolean;
    /** Effective directory axis (its own default already applied per kind). */
    separateWorktree: boolean;
  }): Promise<CreateWorktreeResult> {
    const { repo, profile, sessionId, input, separateBranch, separateWorktree } = opts;

    if (separateBranch) {
      // A separate branch always gets its own directory; an explicit request to
      // share one alongside it is a contradiction.
      if (input.separate_worktree === false) {
        throw ApiError.badRequest(
          'shared_worktree_needs_shared_branch',
          'sharing a working directory requires working on the base branch — disable separate branch first',
        );
      }
      if (input.join_worktree !== undefined) {
        throw ApiError.badRequest(
          'join_needs_shared_branch',
          'joining an existing directory requires working on the base branch — disable separate branch first',
        );
      }
      return this.deps.worktrees.create({
        repo,
        sessionId,
        baseBranch: input.base_branch,
        requestedBranch: input.branch,
        title: input.title ?? null,
        prompt: input.prompt ?? null,
        branchPrefix: profile.branch_prefix,
      });
    }

    // Base branch (no separate branch): a `branch` name makes no sense here.
    if (input.branch !== undefined) {
      throw ApiError.badRequest(
        'branch_with_shared',
        'a session without a separate branch works directly on the base branch; omit branch',
      );
    }

    // Land in a specific existing worktree (the clone or any other on the branch).
    if (input.join_worktree !== undefined) {
      return this.deps.worktrees.joinWorktree({ repo, worktreePath: input.join_worktree });
    }

    // Own new directory on the base branch, or the branch's default shared
    // directory (the clone if on that branch, else the canonical shared
    // worktree) when the caller shares one.
    return separateWorktree
      ? this.deps.worktrees.createOnBase({ repo, sessionId, baseBranch: input.base_branch })
      : this.deps.worktrees.attachShared({ repo, baseBranch: input.base_branch });
  }

  /** Internal one-shot execution; resume always starts an ordinary shell. */
  async createCommandTerminal(
    input: CreateSessionRequest,
    command: TerminalCommand,
  ): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    return this.createTerminal(
      { ...input, kind: 'terminal' },
      project,
      this.deps.profiles.get(project.profile_id),
      this.deps.repos.get(project.repo_id),
      command,
    );
  }

  private async createTerminal(
    input: CreateSessionRequest,
    project: ReturnType<ProjectStore['get']>,
    profile: ReturnType<ProfileStore['get']>,
    repo: ReturnType<RepoStore['get']>,
    command?: TerminalCommand,
  ): Promise<Session> {
    await this.deps.storage?.assertAdmission([...(this.deps.storagePaths ?? []), repo.path]);
    const separateBranch = input.separate_branch === true; // default off for terminals
    const separateWorktree = input.separate_worktree === true; // terminals: share by default
    const sessionId = randomUUID();
    const worktree = await this.resolveSessionWorktree({
      repo,
      profile,
      sessionId,
      input,
      separateBranch,
      separateWorktree,
    });
    await this.deps.storage?.assertAdmission([worktree.worktreePath]);
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: null,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      separate_branch: separateBranch,
      kind: 'terminal',
      agent_type: null,
      title: input.title ?? null,
      skip_permissions: false,
      // Validated before the row exists, so a bad cwd leaves no half-made session.
      cwd: this.validateCwd(worktree.worktreePath, input.cwd),
    });
    await this.spawnTerminal(sessionId, this.startDirOf(session), command);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      kind: 'terminal',
      separate_branch: separateBranch,
      worktree_created: worktree.created,
    });
    this.deps.projects.touch(project.id);
    return this.get(session.id);
  }

  /**
   * Launches (or relaunches) a terminal session's shell on the `agent` PTY term
   * so the existing terminal view attaches to it unchanged. No status detector:
   * a shell only flips `starting → running` on first output and `→ exited` when
   * it dies (SPEC §4).
   */
  /**
   * Validates a requested terminal start directory and returns it in the
   * WORKTREE-RELATIVE form the column stores, or null for the worktree root.
   *
   * Relative so the stored value cannot drift from `worktree_path`, and run
   * through the same containment guard the file routes use, so a `..` can never
   * name a directory outside the worktree.
   */
  private validateCwd(worktreeRoot: string, cwd: string | undefined): string | null {
    if (cwd === undefined || cwd === '') return null;
    const absolute = containedPath(worktreeRoot, cwd);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw ApiError.badRequest('cwd_not_a_directory', `cwd '${cwd}' is not a directory`);
    }
    const rel = relative(worktreeRoot, absolute);
    return rel === '' ? null : rel;
  }

  /**
   * Where this session's shells start: its recorded `cwd` under the worktree,
   * else the worktree root. Falls back to the root if the directory has since
   * been deleted — a stale `cwd` must not make the session unspawnable.
   */
  private startDirOf(session: Session): string {
    const cwd = session.cwd ?? null;
    if (cwd === null || cwd === '') return session.worktree_path;
    const absolute = join(session.worktree_path, cwd);
    return existsSync(absolute) && statSync(absolute).isDirectory()
      ? absolute
      : session.worktree_path;
  }

  private async spawnTerminal(
    sessionId: string,
    worktreePath: string,
    command?: TerminalCommand,
    beforeLaunch?: RuntimeLaunchGuard,
  ): Promise<void> {
    this.assertLegacyRuntime(sessionId);
    if (this.launchBackend.kind === 'independent') {
      try {
        await this.launchBackend.launcher.launch(
          sessionId,
          (hooks) => {
            const { shell, args, env } = this.environment.shellSpawnParts(sessionId, false, hooks);
            return {
              file: command ? '/bin/sh' : shell,
              args: command ? terminalCommandArgs(command, shell, args) : args,
              cwd: command?.cwd ?? worktreePath,
              env: { ...env, ...command?.env },
              cols: 120,
              rows: 32,
            };
          },
          { codeRunDirectory: command?.managedRunDirectory, beforeLaunch },
        );
      } catch (error) {
        // Prepared intent may already be executing. Never erase that ownership
        // or fall back to another spawn after a missing supervisor response.
        if (
          !this.deps.runtimes?.ownerOf(sessionId) &&
          !this.shuttingDown &&
          this.deps.sessions.get(sessionId).status !== 'archived'
        ) {
          this.transition(sessionId, 'exited');
          this.deps.events.record(sessionId, 'spawn_failed', { message: String(error) });
        }
        throw error;
      }
      return;
    }
    this.legacy.spawnTerminal(sessionId, worktreePath, command);
  }

  async resume(id: string): Promise<Session> {
    return this.lifecycleMutex.run('native-conversation-switch', () => this.resumeCore(id));
  }

  private async resumeCore(id: string, beforeLaunch?: RuntimeLaunchGuard): Promise<Session> {
    this.assertLegacyRuntime(id);
    const session = this.deps.sessions.get(id);
    await this.deps.storage?.assertAdmission([
      ...(this.deps.storagePaths ?? []),
      session.worktree_path,
    ]);
    if (session.conversation_missing) {
      throw ApiError.conflict(
        'conversation_missing',
        'the native conversation no longer exists; this placement cannot resume',
      );
    }
    if (session.conversation_id !== null && session.conversation_id !== undefined) {
      const owner = this.legacy.conversation(session.conversation_id);
      if (owner && owner.activeSessionId !== id) {
        const existing = this.deps.sessions.get(owner.activeSessionId);
        throw ApiError.conflict(
          'conversation_live',
          'this native conversation is already running in another placement',
          { existing_session_id: existing.id, existing_project_id: existing.project_id },
        );
      }
    }
    if (session.status !== 'exited' && session.status !== 'interrupted') {
      throw ApiError.conflict(
        'not_resumable',
        `session is ${session.status}; only exited or interrupted sessions resume`,
      );
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    // A terminal session has no conversation to resume — a shell process cannot
    // be reattached across a restart — so "resume" just relaunches a fresh
    // shell, in the SAME directory it was opened in (`cwd`, SPEC §4).
    if (session.kind === 'terminal') {
      const wasInterrupted = session.status === 'interrupted';
      await this.spawnTerminal(session.id, this.startDirOf(session), undefined, beforeLaunch);
      if (!this.deps.runtimes?.usesExternalTerminals(session.id))
        this.transition(session.id, 'running');
      this.deps.events.record(id, 'resumed', { was_interrupted: wasInterrupted });
      return this.get(id);
    }
    if (session.account_id === null || session.agent_type === null) {
      throw ApiError.conflict('not_resumable', 'session has no agent to resume');
    }
    const account = this.deps.accounts.get(session.account_id);
    const project = this.deps.projects.get(session.project_id);
    const adapter = this.deps.adapters.get(session.agent_type);
    if (!adapter.capabilities.resume) {
      throw ApiError.badRequest(
        'resume_unsupported',
        `${adapter.displayName} cannot resume conversations`,
      );
    }
    assertBinaryAvailable(adapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(account, adapter);
    const ref =
      session.agent_mode === 'headless' && !session.agent_session_ref
        ? undefined
        : await this.identity.refs.resolveForResume(
            session,
            account,
            adapter,
            this.deps.runtimePriorRefs?.(session.id),
          );

    const wasInterrupted = session.status === 'interrupted';
    const { skip } = await this.resumeSpawn(session, account, adapter, project.profile_id, ref, {
      interruptedNote: wasInterrupted,
      beforeLaunch,
    });
    this.deps.events.record(id, 'resumed', {
      was_interrupted: wasInterrupted,
      skip_permissions: skip,
    });
    this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    return this.get(id);
  }

  /**
   * Shared resume spawn path for `resume` and `migrate` (SPEC §11.4). The
   * permissions gate is RE-EVALUATED for THIS account at THIS moment — a
   * session that ran without prompts loses the flag if the gate has since
   * closed or the target account never opted in; the resume continues with
   * prompts on and says so in the terminal (a silent downgrade, never a hard
   * failure). Spawns the agent under the account's env in the session's
   * worktree, transitions to `running`, and returns the effective flags. The
   * caller records the lifecycle event (`resumed` / `migrated`).
   */
  private async resumeSpawn(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    profileId: string,
    ref: string | undefined,
    opts: { interruptedNote: boolean; beforeLaunch?: RuntimeLaunchGuard },
  ): Promise<{ skip: boolean; downgraded: boolean }> {
    const skip = this.evaluateSkip(profileId, account, adapter, session.skip_permissions);
    const downgraded = session.skip_permissions && !skip;
    if (downgraded) this.deps.sessions.setSkipPermissions(session.id, false);
    // The interruption note is the profile's `restartTemplate` (Settings →
    // Sessions), falling back to the built-in default; a cleared template sends
    // no note at all.
    let restartNote: string | undefined;
    if (opts.interruptedNote) {
      const note = buildInterruptedResumeNote(
        this.deps.profiles.getSettings(profileId).restartTemplate,
      );
      restartNote = note.trim() === '' ? undefined : note;
    }
    const launchOpts = {
      worktreePath: session.worktree_path,
      sessionId: session.id,
      prompt: restartNote,
      skipPermissions: skip,
    };
    const args = ref ? adapter.resumeArgs(ref, launchOpts) : adapter.launchArgs(launchOpts);
    await this.spawnAgent(
      session.id,
      session.worktree_path,
      account,
      adapter,
      args,
      'running',
      launchOpts,
      ref,
      undefined,
      opts.beforeLaunch,
    );
    this.legacy.bindRuntimeConversation(session.id);
    if (!this.deps.runtimes?.usesExternalTerminals(session.id))
      this.transition(session.id, 'running');
    if (downgraded) {
      if (this.deps.runtimes?.ownerOf(session.id))
        this.emit('notice', {
          level: 'warning',
          title: 'Permission prompts enabled',
          detail: 'skip-permissions no longer permitted; continuing with prompts on.',
          session: session.id,
        } satisfies NoticeEvent);
      else
        this.deps.ptys.note(
          session.id,
          'agent',
          'skip-permissions no longer permitted; continuing with prompts on.',
        );
    }
    return { skip, downgraded };
  }

  /** Tier-1 migration shares the same native-conversation exclusion as resume. */
  async migrate(
    id: string,
    targetAccountId: number,
    authorised: () => boolean = () => true,
  ): Promise<Session> {
    await this.lifecycleAdmission.run(() =>
      this.lifecycleMutex.run('native-conversation-switch', () =>
        migrateSessionAccount(this.deps, id, targetAccountId, authorised, {
          checkLoggedIn: (account, adapter) => this.assertLoggedIn(account, adapter),
          kill: (sessionId, check) => this.kill(sessionId, check),
          resume: (session, account, adapter, profile, ref, beforeLaunch) =>
            this.resumeSpawn(session, account, adapter, profile, ref, {
              interruptedNote: false,
              beforeLaunch,
            }),
        }),
      ),
    );
    return this.get(id);
  }

  /**
   * Tier-2 cross-agent hand-off (SPEC §5): continue this session's work on a
   * DIFFERENT agent. Nothing moves — no shared conversation format exists — so
   * a new session is created in the same worktree and branch, seeded with a
   * briefing summarising the conversation and the branch state. The source
   * session is deliberately left alone: it keeps its status and its history,
   * and the two are linked by events.
   */
  async handoff(id: string, targetAccountId: number): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.kind === 'terminal' || session.account_id === null || session.agent_type === null) {
      throw ApiError.badRequest('not_migratable', 'a terminal session has no agent to hand off');
    }
    const project = this.deps.projects.get(session.project_id);
    const target = this.deps.accounts.get(targetAccountId); // 404 if unknown
    // Validations mirror migrate()'s, in the same order (SPEC §5).
    if (target.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'cross_profile_account',
        'the target account belongs to a different profile',
      );
    }
    if (target.agent_type === session.agent_type) {
      throw ApiError.badRequest(
        'same_agent',
        `the target account also runs ${session.agent_type}; use migrate to move between accounts of one agent`,
      );
    }
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'an archived session cannot hand off');
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    const targetAdapter = this.deps.adapters.get(target.agent_type);
    assertBinaryAvailable(targetAdapter); // before assertLoggedIn — see its doc comment
    await this.assertLoggedIn(target, targetAdapter);

    const prompt = await buildHandoffPrompt({
      adapter: this.deps.adapters.get(session.agent_type),
      account: this.deps.accounts.get(session.account_id),
      session,
      logs: this.deps.logs,
    });
    // `join_worktree` lands the new session in the source's directory, on
    // whatever branch is checked out there — no second `git worktree add`, and
    // no onboarding, since the worktree is a reuse rather than a fresh one.
    const created = await this.create({
      project_id: session.project_id,
      account_id: target.id,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: session.worktree_path,
      prompt,
      skip_permissions: session.skip_permissions,
    });
    this.deps.events.record(id, 'handed_off_to', {
      to_session: created.id,
      to_account: target.id,
      to_agent: target.agent_type,
    });
    this.deps.events.record(created.id, 'handed_off_from', {
      from_session: id,
      from_account: session.account_id,
      from_agent: session.agent_type,
    });
    return created;
  }

  inspectRuntime(id: string, authorised: () => boolean): Promise<SessionRuntimeInspection> {
    return this.runtimeMaintenance.inspect(id, authorised);
  }

  restartRuntime(
    id: string,
    request: RestartSessionRuntimeRequest,
    authorised: () => boolean,
  ): Promise<Session> {
    return this.lifecycleMutex.run('native-conversation-switch', () =>
      this.runtimeMaintenance.restart(id, request, authorised),
    );
  }

  /** SIGTERM the session's PTYs and wait for the agent to exit. */
  async kill(id: string, authorised: () => boolean = () => true): Promise<Session> {
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    if (this.deps.runtimes?.ownerOf(id)) {
      if (!this.deps.runtimeControls) this.assertLegacyRuntime(id);
      await this.deps.runtimeControls!.stop(id, authorised);
      this.deps.events.record(id, 'killed');
      return this.get(id);
    }
    this.assertLegacyRuntime(id);
    await this.legacy.kill(id);
    this.deps.events.record(id, 'killed');
    return this.get(id);
  }

  /**
   * Archive a session (SPEC §4): a reversible hide, NOT a teardown. A live
   * session is killed first; the worktree, its branch, and the agent's
   * conversation all stay exactly where they are, so the session can be
   * unarchived later and — if its worktree is still on disk — resumed with
   * its history intact. Reclaiming a worktree's disk is a separate, explicit
   * action in the Worktrees manager; deleting a branch is done there too
   * (git refuses while the branch is checked out in the kept worktree).
   */
  async archive(id: string, authorised: () => boolean = () => true): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status === 'archived') return session; // an idempotent hide
    // A live session is killed as part of archiving — one gesture from the
    // UI, no kill-then-archive dance. Still nothing is destroyed: the
    // conversation stays exactly as resumable after an unarchive.
    if (
      LIVE_STATUSES.includes(session.status) ||
      this.deps.runtimes?.ownerOf(id) ||
      this.deps.ptys.liveTerms(id).length > 0
    )
      await this.kill(id, authorised);
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    if (this.deps.runtimes?.ownerOf(id) || this.deps.ptys.liveTerms(id).length > 0)
      throw ApiError.conflict(
        'session_changed',
        'The session started again while archive was waiting.',
      );
    this.deps.onboarding.unwatch(id);
    this.identity.forget(id);
    this.transition(id, 'archived');
    this.deps.events.record(id, 'archived', {});
    return this.get(id);
  }

  /**
   * Reverse an archive (SPEC §4): bring the session back to a resumable state.
   * We never recreate a worktree — if it was pruned, or its branch was moved or
   * deleted, the session returns visible for its terminal/conversation history
   * only, with resume disabled through the read-time `worktree_missing` flag.
   */
  async unarchive(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status !== 'archived') {
      throw ApiError.conflict('not_archived', 'only an archived session can be unarchived');
    }
    const worktreePresent = existsSync(session.worktree_path);
    this.transition(id, 'exited');
    this.deps.events.record(id, 'unarchived', { worktree_present: worktreePresent });
    if (worktreePresent) {
      const project = this.deps.projects.get(session.project_id);
      this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    }
    return this.get(id);
  }

  /** Archives all sessions of a project; refuses live ones unless forced (SPEC §4). */
  async archiveProject(
    projectId: string,
    force = false,
    authorised: () => boolean = () => true,
  ): Promise<void> {
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    this.deps.projects.get(projectId); // 404 guard
    const sessions = this.deps.sessions.list({ project_id: projectId });
    const live = sessions.filter(
      (s) =>
        LIVE_STATUSES.includes(s.status) ||
        this.deps.runtimes?.ownerOf(s.id) ||
        this.deps.ptys.liveTerms(s.id).length > 0,
    );
    if (live.length > 0 && !force) {
      throw ApiError.conflict(
        'project_live',
        `${live.length} session(s) are running or waiting; archive with force to kill them`,
      );
    }
    for (const s of live) await this.kill(s.id, authorised);
    for (const s of sessions) {
      if (s.status !== 'archived') await this.archive(s.id, authorised);
    }
  }

  /** Spawn a shell PTY cd'd into the worktree; returns the new term id. */
  async spawnShell(sessionId: string, authorised: () => boolean = () => true): Promise<string> {
    const external = this.deps.runtimes?.ownerOf(sessionId);
    if (external && !this.deps.runtimeControls) this.assertLegacyRuntime(sessionId);
    const session = this.deps.sessions.get(sessionId);
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'archived sessions have no worktree');
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict('worktree_missing', 'worktree is gone');
    }
    if (external) {
      const { shell, args, env } = this.environment.shellSpawnParts(sessionId, false);
      return this.deps.runtimeControls!.spawnShell(
        sessionId,
        {
          file: shell,
          args,
          env,
          cwd: this.startDirOf(session),
          cols: 120,
          rows: 32,
        },
        () => this.environment.captureEnvEnabled(session.project_id),
        authorised,
      );
    }
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    return this.legacy.spawnShell(sessionId, this.startDirOf(session));
  }

  /**
   * Stored logged-in flags go stale (keychain-bound credentials die with a
   * path change) — ask the agent before anything spawns, and keep the flag
   * truthful. A logged-out account would otherwise show its login screen
   * INSIDE the session and discard the preset session id.
   *
   * ALWAYS call `assertBinaryAvailable` first. Adapters implement `checkLoggedIn`
   * by asking their own CLI, so an uninstalled agent reports "logged out" — and
   * the write below would then clear a perfectly good `logged_in` flag and send
   * the user to a login flow that cannot work. This assumes the binary exists.
   */
  private async assertLoggedIn(account: Account, adapter: AgentAdapter): Promise<void> {
    if (!adapter.checkLoggedIn) return;
    const loggedIn = await adapter.checkLoggedIn(account);
    if (loggedIn !== account.logged_in) this.deps.accounts.setLoggedIn(account.id, loggedIn);
    if (!loggedIn) {
      throw ApiError.conflict(
        'account_logged_out',
        `account '${account.label}' is not logged in — log in via Settings → Accounts first`,
      );
    }
  }

  /** requested ∧ profile gate ∧ account opt-in ∧ adapter capability (SPEC §11). */
  private evaluateSkip(
    profileId: string,
    account: Account,
    adapter: AgentAdapter,
    requested: boolean | undefined,
  ): boolean {
    if (requested !== true) return false;
    if (!adapter.capabilities.skipPermissions) return false;
    const settings = this.deps.profiles.getSettings(profileId);
    return settings.allowSkipPermissions === true && account.skip_permissions_default;
  }

  capturedEnv(id: string): SessionEnvResponse {
    return this.environment.capturedEnv(id);
  }

  /** DELETE /api/sessions/:id/env: stop injecting; returns how many vars were dropped. */
  async clearCapturedEnv(
    id: string,
    authorised: () => boolean = () => true,
  ): Promise<ClearSessionEnvResponse> {
    if (this.deps.runtimes?.ownerOf(id)) {
      if (!this.deps.runtimeControls) this.assertLegacyRuntime(id);
      return { cleared: await this.deps.runtimeControls!.clearEnvironment(id, authorised) };
    }
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    this.assertLegacyRuntime(id);
    return { cleared: this.deps.sessions.clearEnv(id) };
  }

  private async spawnAgent(
    sessionId: string,
    worktreePath: string,
    account: Account,
    adapter: AgentAdapter,
    args: string[],
    initial: Extract<SessionStatus, 'starting' | 'running' | 'waiting_input'>,
    launchOpts?: LaunchOpts,
    resumeRef?: string,
    programme?: ProgrammeOperation,
    beforeLaunch?: RuntimeLaunchGuard,
  ): Promise<void> {
    this.assertLegacyRuntime(sessionId);
    await this.deps.storage?.assertAdmission([
      ...(this.deps.storagePaths ?? []),
      worktreePath,
      account.config_dir,
    ]);
    this.assertLegacyRuntime(sessionId);
    if (this.launchBackend.kind === 'independent') {
      try {
        const mode = this.deps.sessions.get(sessionId).agent_mode ?? 'interactive';
        const opts = launchOpts ?? {
          worktreePath,
          sessionId,
          skipPermissions: this.deps.sessions.get(sessionId).skip_permissions,
        };
        const initialRef =
          !resumeRef && mode === 'interactive' && adapter.capabilities.presetSessionId
            ? await adapter.resolveSessionRef(opts, account)
            : undefined;
        const priorRefs =
          !resumeRef && !adapter.capabilities.presetSessionId && adapter.existingSessionRefs
            ? [...(await adapter.existingSessionRefs(worktreePath, account))]
            : undefined;
        if (initialRef !== undefined) this.deps.sessions.setAgentSessionRef(sessionId, initialRef);
        await this.launchBackend.launcher.launch(
          sessionId,
          () => ({
            file: adapter.binary,
            args: [],
            cwd: worktreePath,
            env: {},
            cols: 120,
            rows: 32,
          }),
          {
            programme,
            beforeLaunch,
            provider: {
              id: adapter.id,
              config_dir: account.config_dir,
              mode,
              skip_permissions: opts.skipPermissions,
              ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
              ...(resumeRef === undefined ? {} : { resume_ref: resumeRef }),
              ...(initialRef === undefined ? {} : { initial_ref: initialRef }),
              ...(priorRefs === undefined ? {} : { prior_refs: priorRefs }),
            },
          },
        );
        if (this.deps.sessions.get(sessionId).native_sync === 'fallback')
          this.emit('notice', {
            level: 'warning',
            title: 'Conversation switching is not synchronised',
            detail: `${adapter.displayName} will keep running, but in-agent conversation switches will stay in this terminal tab.`,
            session: sessionId,
          } satisfies NoticeEvent);
      } catch (error) {
        if (
          !this.deps.runtimes?.ownerOf(sessionId) &&
          !this.shuttingDown &&
          this.deps.sessions.get(sessionId).status !== 'archived'
        ) {
          this.transition(sessionId, 'exited');
          this.deps.events.record(sessionId, 'spawn_failed', { message: String(error) });
        }
        throw error;
      }
      return;
    }
    await this.legacy.spawnAgent(
      sessionId,
      worktreePath,
      account,
      adapter,
      args,
      initial,
      launchOpts,
      resumeRef,
    );
  }

  setSignalPort(port: number): void {
    this.legacy.setSignalPort(port);
  }
  signalNonceFor(session: string): string | null {
    return this.legacy.signalNonceFor(session);
  }
  signalAgentStatus(nonce: string, state: 'working' | 'waiting_input'): boolean {
    return this.legacy.signalAgentStatus(nonce, state);
  }
  signalAgentTurn(signal: AgentTurnSignal): boolean {
    return this.legacy.signalAgentTurn(signal);
  }
  signalAgentLifecycle(signal: LifecycleSignal): Promise<boolean> {
    return this.legacy.signalAgentLifecycle(signal);
  }
  expectExit(stream: string, term?: string): void {
    this.legacy.expectExit(stream, term);
  }

  private transition(id: string, status: SessionStatus): void {
    const s = this.deps.sessions.setStatus(id, status);
    this.persistence.forget(id);
    this.emit('status', {
      session: id,
      status,
      last_activity_at: s.last_activity_at,
    } satisfies StatusEvent);
  }

  /** Worktree-missing and stale-running badges are computed, never stored (SPEC §4). */
  private withComputed(session: Session): Session {
    const pending = this.persistence.state(session.id);
    if (pending) session = { ...session, status: pending.status, persistence_pending: true };
    if (session.kind === 'terminal') {
      const detected = this.legacy.terminalAgent(session.id);
      session = {
        ...session,
        detected_agent_type:
          detected === undefined
            ? (this.deps.runtimeTerminalAgent?.(session.id) ?? null)
            : detected,
      };
    }
    if (session.status === 'archived') return session;
    const computed = existsSync(session.worktree_path)
      ? session
      : { ...session, worktree_missing: true };
    return this.legacy.staleRunning(computed) ? { ...computed, stale_running: true } : computed;
  }
}
