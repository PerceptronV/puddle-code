import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { Account, CreateSessionRequest, Session, SessionStatus } from '@puddle/shared';
import type { AgentAdapter } from '../agents/adapter.js';
import type { AdapterRegistry } from '../agents/registry.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { EventStore } from '../db/stores/events.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { ApiError } from '../http/errors.js';
import type { LogStore } from '../logs/log-store.js';
import { extractOscTitle } from '../pty/ansi.js';
import type { PtyDataEvent, PtyExitEvent, PtyManager } from '../pty/pty-manager.js';
import type { ShellHooks } from '../pty/shell-hooks.js';
import { StatusDetector, type DetectedStatus } from '../pty/status-detector.js';
import type { CreateWorktreeResult, WorktreeManager } from '../worktrees/manager.js';
import type { ConversationShare } from './conversation-share.js';
import {
  buildConcurrentWorktreeNote,
  buildInterruptedResumeNote,
  buildOnboardingPreamble,
} from './onboarding.js';
import type { MarkerFileSync } from './onboarding.js';

export interface SessionServiceDeps {
  profiles: ProfileStore;
  accounts: AccountStore;
  repos: RepoStore;
  projects: ProjectStore;
  sessions: SessionStore;
  events: EventStore;
  worktrees: WorktreeManager;
  ptys: PtyManager;
  adapters: AdapterRegistry;
  logs: LogStore;
  onboarding: MarkerFileSync;
  /** Shared conversation store (Workstream S); absent → no adoption. */
  share?: ConversationShare;
  /** Captured-env shell hooks (SPEC §4); absent → plain shells, no capture. */
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

export interface RenameEvent {
  session: string;
  /** User override (null → use agent_title, then osc_title, then the id prefix). */
  title: string | null;
  /** The agent's own name; carried so a live agent-title change updates the default. */
  agent_title: string | null;
  /** The terminal-title "sequence" name; carried so a live change updates the default. */
  osc_title?: string | null;
}

interface LiveAgent {
  /** Null for terminal sessions — a plain shell has no status detector. */
  detector: StatusDetector | null;
  status: Extract<SessionStatus, 'starting' | 'running' | 'waiting_input'>;
  lastTouch: number;
  /** Throttle for the OSC-title-driven agent-name re-read (see onPtyData). */
  lastTitleCheck: number;
  /** Last OSC "sequence" title seen, to persist/broadcast only on a real change. */
  lastOscTitle: string | null;
}

const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

// How often to re-read each live agent's own session name. A rename made INSIDE
// the agent (e.g. Claude Code's `/rename`) is a client-side transcript edit that
// triggers no status change and — while the session sits idle — no terminal-title
// escape either, so the event-driven refreshes (status change, OSC title, exit)
// all miss it. This cheap periodic re-read (adapter.sessionTitle is a tail read
// that early-returns when unchanged) surfaces such renames within a few seconds.
const TITLE_REFRESH_MS = 3000;

/**
 * Orchestrates the session state machine (SPEC §4). SQLite rows are the
 * durable truth; `liveAgents` tracks the in-memory attachment (detector +
 * cached status) for each live agent PTY. Emits 'status' (StatusEvent) and
 * 'renamed' (RenameEvent).
 */
export class SessionService extends EventEmitter {
  private readonly liveAgents = new Map<string, LiveAgent>();
  /** Sessions whose conversation is already adopted — stops the retry loop. */
  private readonly adopted = new Set<string>();
  private shuttingDown = false;
  private readonly titleTimer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: SessionServiceDeps) {
    super();
    deps.ptys.on('data', (e: PtyDataEvent) => this.onPtyData(e));
    deps.ptys.on('exit', (e: PtyExitEvent) => this.onPtyExit(e));
    // Catch in-agent renames that emit no signal (see TITLE_REFRESH_MS). Unref'd
    // so it never keeps the process (or a test run) alive.
    this.titleTimer = setInterval(() => {
      for (const id of this.liveAgents.keys()) this.refreshAgentTitle(id);
    }, this.deps.titleRefreshMs ?? TITLE_REFRESH_MS);
    this.titleTimer.unref?.();
  }

  /**
   * Daemon shutdown: PTYs are about to be killed, but their sessions must
   * KEEP their live status rows — the next boot's reconcile pass turns them
   * into `interrupted` (SPEC §4). Without this, the exit handlers would
   * record a graceful `exited` and the restart AT would lie.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    clearInterval(this.titleTimer);
  }

  get(id: string): Session {
    return this.withComputed(this.deps.sessions.get(id));
  }

  list(
    filter: { project_id?: string; profile_id?: string; status?: SessionStatus } = {},
  ): Session[] {
    return this.deps.sessions.list(filter).map((s) => this.withComputed(s));
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

  /**
   * Re-reads the agent's own session name (adapter.sessionTitle) and, when it
   * changed, stores it in `agent_title` and broadcasts — so an attached client's
   * default display name tracks the agent live (a user override still wins).
   * Best-effort: hooked off status changes and exit, and never throws upward.
   */
  private refreshAgentTitle(sessionId: string): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    if (session.kind !== 'agent' || !session.agent_session_ref || session.account_id === null)
      return;
    let next: string | null;
    try {
      const account = this.deps.accounts.get(session.account_id);
      const adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
      if (!adapter.sessionTitle) return;
      next = adapter.sessionTitle(session.agent_session_ref, account);
    } catch {
      return;
    }
    if ((next ?? null) === (session.agent_title ?? null)) return;
    this.deps.sessions.setAgentTitle(sessionId, next);
    this.emit('renamed', {
      session: sessionId,
      title: session.title,
      agent_title: next,
      osc_title: session.osc_title ?? null,
    } satisfies RenameEvent);
  }

  async create(input: CreateSessionRequest): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    const profile = this.deps.profiles.get(project.profile_id);
    const repo = this.deps.repos.get(project.repo_id);

    // A terminal session has no account/agent — it forks off into its own path
    // (a shell in the worktree, no onboarding, no conversation — SPEC §4).
    if ((input.kind ?? 'agent') === 'terminal') {
      return this.createTerminal(input, project, profile, repo);
    }
    if (input.account_id === undefined) {
      throw ApiError.badRequest('account_required', 'an agent session needs an account_id');
    }
    const account = this.deps.accounts.get(input.account_id);
    if (account.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'foreign_account',
        'the account does not belong to this project’s profile',
      );
    }
    const adapter = this.deps.adapters.get(account.agent_type);
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
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: account.id,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      separate_branch: separateBranch,
      kind: 'agent',
      agent_type: account.agent_type,
      title: input.title ?? null,
      skip_permissions: skip,
    });

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
    this.spawnAgent(
      sessionId,
      worktree.worktreePath,
      account,
      adapter,
      adapter.launchArgs(launchOpts),
      'starting',
    );
    const ref = await adapter.resolveSessionRef(launchOpts, account);
    this.deps.sessions.setAgentSessionRef(sessionId, ref);
    // Adopt-after-first-write: the conversation file rarely exists this early,
    // so this is a best-effort first attempt; the waiting_input flip retries.
    this.scheduleAdopt(sessionId);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      account_id: account.id,
      skip_permissions: skip,
      separate_branch: separateBranch,
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

  private async createTerminal(
    input: CreateSessionRequest,
    project: ReturnType<ProjectStore['get']>,
    profile: ReturnType<ProfileStore['get']>,
    repo: ReturnType<RepoStore['get']>,
  ): Promise<Session> {
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
    });
    this.spawnTerminal(sessionId, worktree.worktreePath);
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
  private spawnTerminal(sessionId: string, worktreePath: string): void {
    const shell = process.env.SHELL ?? 'bash';
    try {
      this.deps.ptys.spawn(sessionId, 'agent', shell, [], { cwd: worktreePath });
    } catch (e) {
      this.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(500, 'spawn_failed', `could not start ${shell}: ${(e as Error).message}`);
    }
    this.liveAgents.set(sessionId, {
      detector: null,
      status: 'starting',
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
    });
  }

  async resume(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
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
    // shell in the same worktree, keeping it alive like any other session.
    if (session.kind === 'terminal') {
      const wasInterrupted = session.status === 'interrupted';
      this.spawnTerminal(session.id, session.worktree_path);
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
    await this.assertLoggedIn(account, adapter);
    let ref = session.agent_session_ref;
    if (!ref) throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');
    if (adapter.hasConversation && !adapter.hasConversation(ref, account)) {
      // The recorded ref matches nothing — e.g. the agent's login screen
      // restarted the session under a fresh id. Recover by worktree.
      const recovered = adapter.discoverSessionRef?.(session.worktree_path, account) ?? null;
      if (recovered === null) {
        throw ApiError.conflict(
          'conversation_missing',
          `${adapter.displayName} has no conversation ${ref} for this account; the session cannot resume`,
        );
      }
      ref = recovered;
      this.deps.sessions.setAgentSessionRef(id, ref);
      this.deps.events.record(id, 'session_ref_recovered', { ref });
    }

    const wasInterrupted = session.status === 'interrupted';
    const { skip } = this.resumeSpawn(session, account, adapter, project.profile_id, ref, {
      interruptedNote: wasInterrupted,
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
  private resumeSpawn(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    profileId: string,
    ref: string,
    opts: { interruptedNote: boolean },
  ): { skip: boolean; downgraded: boolean } {
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
    const args = adapter.resumeArgs(ref, {
      worktreePath: session.worktree_path,
      sessionId: session.id,
      prompt: restartNote,
      skipPermissions: skip,
    });
    this.spawnAgent(session.id, session.worktree_path, account, adapter, args, 'running');
    this.transition(session.id, 'running');
    if (downgraded) {
      this.deps.ptys.note(
        session.id,
        'agent',
        'skip-permissions no longer permitted; continuing with prompts on.',
      );
    }
    return { skip, downgraded };
  }

  /**
   * Tier-1 migration (SPEC §5): move a session to another account of the same
   * (profile, agent) and resume it under that account's credentials. The
   * conversation does NOT move — it lives in the profile's shared store,
   * reachable from every account through its symlinks — so migration is
   * "stop the process, repoint `account_id`, resume under B's env".
   */
  async migrate(id: string, targetAccountId: number): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.kind === 'terminal' || session.account_id === null || session.agent_type === null) {
      throw ApiError.badRequest('not_migratable', 'a terminal session has no account to migrate');
    }
    const project = this.deps.projects.get(session.project_id);
    const target = this.deps.accounts.get(targetAccountId); // 404 if unknown
    // Validations, in order (SPEC §5).
    if (target.profile_id !== project.profile_id) {
      throw ApiError.badRequest(
        'cross_profile_account',
        'the target account belongs to a different profile',
      );
    }
    if (target.agent_type !== session.agent_type) {
      throw ApiError.badRequest(
        'agent_mismatch',
        `the target account runs ${target.agent_type}, not ${session.agent_type}`,
      );
    }
    if (target.id === session.account_id) {
      throw ApiError.badRequest('same_account', 'the session already runs on this account');
    }
    // An archived session has no live worktree/process to carry over.
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'an archived session cannot migrate');
    }
    // Same guard resume has: a vanished worktree is a 409, not a spawn 500.
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict(
        'worktree_missing',
        'worktree is gone; the session can only be archived',
      );
    }
    const adapter = this.deps.adapters.get(session.agent_type);
    // A live session is stopped first — usually it has already exited (credit
    // exhaustion). kill() waits for the PTY to die before returning.
    if (LIVE_STATUSES.includes(session.status)) await this.kill(id);
    // The target must be logged in — the same probe create/resume use.
    await this.assertLoggedIn(target, adapter);

    const ref = session.agent_session_ref;
    if (!ref) throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');

    // A session that exhausted credit on its very FIRST turn may never have hit
    // waiting_input, so its conversation was never adopted into the shared store
    // — `hasConversation(target)` below would then be false and migration would
    // wrongly 409, defeating the primary use case. Force a best-effort adopt now
    // (the source account is still `account_id`, so it owns the files); an
    // adoption failure simply falls through to the availability paths below.
    if (this.deps.share) {
      try {
        await this.deps.share.adoptIfNeeded(session);
      } catch {
        /* best-effort — falls through to the (a)/(b)/(c) availability paths */
      }
    }

    // Conversation availability on the target, in fall-through order (SPEC §5):
    // (a) readable through the shared store's symlink — no files move;
    // (b) an agent without a shareable store copies its state across (rolled
    //     back on a later failure per the adapter contract);
    // (c) neither — the conversation cannot follow the account.
    let rollback: (() => Promise<void>) | null = null;
    if (adapter.conversationShare && adapter.hasConversation?.(ref, target)) {
      // (a) — nothing to do; the target already reads the conversation.
    } else if (adapter.migrateSession) {
      const from = this.deps.accounts.get(session.account_id);
      await adapter.migrateSession(ref, from, target, session.worktree_path);
      rollback = async () => {
        try {
          await adapter.migrateSession!(ref, target, from, session.worktree_path);
        } catch {
          /* best-effort — the copied files are the caller's to reconcile */
        }
      };
    } else {
      throw ApiError.conflict(
        'migration_unsupported',
        `${adapter.displayName} cannot migrate this conversation to another account`,
      );
    }

    const fromAccountId = session.account_id;
    this.deps.sessions.setAccountId(id, target.id);
    try {
      this.resumeSpawn(session, target, adapter, project.profile_id, ref, {
        interruptedNote: false,
      });
    } catch (e) {
      // Path (b) rolls the copied files back and reverts the account (409).
      // Path (a) leaves `account_id` on the target — the conversation is
      // shared, so a plain retry resume recovers — and surfaces the error.
      if (rollback) {
        await rollback();
        this.deps.sessions.setAccountId(id, fromAccountId);
      }
      throw e;
    }
    this.deps.events.record(id, 'migrated', {
      from_account: fromAccountId,
      to_account: target.id,
    });
    // Resume the marker-file sync the way resume() does, so a shared-worktree
    // session keeps title/onboarding markers flowing after migration.
    this.deps.onboarding.watch(id, project.repo_id, session.worktree_path);
    return this.get(id);
  }

  /** SIGTERM the session's PTYs and wait for the agent to exit. */
  async kill(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    this.deps.ptys.killAll(id);
    const deadline = Date.now() + 4000;
    let escalated = false;
    while (this.deps.ptys.has(id, 'agent')) {
      if (Date.now() > deadline + 2000)
        throw new ApiError(500, 'kill_failed', 'agent PTY refused to die');
      if (!escalated && Date.now() > deadline) {
        this.deps.ptys.kill(id, 'agent', 'SIGKILL');
        escalated = true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (LIVE_STATUSES.includes(session.status)) {
      // The exit handler normally does this; cover the no-PTY edge.
      if (this.deps.sessions.get(id).status !== 'exited') this.transition(id, 'exited');
    }
    this.deps.events.record(id, 'killed');
    return this.get(id);
  }

  /**
   * Archive a session (SPEC §4): a reversible hide, NOT a teardown. The worktree,
   * its branch, and the agent's conversation all stay exactly where they are, so
   * the session can be unarchived later and — if its worktree is still on disk —
   * resumed with its history intact. Reclaiming a worktree's disk is a separate,
   * explicit action in the Worktrees manager; deleting a branch is done there
   * too (git refuses while the branch is checked out in the kept worktree).
   */
  async archive(id: string): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status !== 'exited' && session.status !== 'interrupted') {
      throw ApiError.conflict('session_live', 'a running session must be killed before archiving');
    }
    this.deps.onboarding.unwatch(id);
    this.adopted.delete(id);
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
  async archiveProject(projectId: string, force = false): Promise<void> {
    this.deps.projects.get(projectId); // 404 guard
    const sessions = this.deps.sessions.list({ project_id: projectId });
    const live = sessions.filter((s) => LIVE_STATUSES.includes(s.status));
    if (live.length > 0 && !force) {
      throw ApiError.conflict(
        'project_live',
        `${live.length} session(s) are running or waiting; archive with force to kill them`,
      );
    }
    for (const s of live) await this.kill(s.id);
    for (const s of sessions) {
      if (s.status !== 'archived') await this.archive(s.id);
    }
  }

  /** Spawn a shell PTY cd'd into the worktree; returns the new term id. */
  spawnShell(sessionId: string): string {
    const session = this.deps.sessions.get(sessionId);
    if (session.status === 'archived') {
      throw ApiError.conflict('session_archived', 'archived sessions have no worktree');
    }
    if (!existsSync(session.worktree_path)) {
      throw ApiError.conflict('worktree_missing', 'worktree is gone');
    }
    const used = new Set([
      ...this.deps.logs.listTerms(sessionId),
      ...this.deps.ptys.liveTerms(sessionId),
    ]);
    let n = 1;
    while (used.has(`shell-${n}`)) n++;
    const term = `shell-${n}`;
    const shell = process.env.SHELL ?? 'bash';
    this.deps.ptys.spawn(sessionId, term, shell, [], { cwd: session.worktree_path });
    return term;
  }

  /**
   * Stored logged-in flags go stale (keychain-bound credentials die with a
   * path change) — ask the agent before anything spawns, and keep the flag
   * truthful. A logged-out account would otherwise show its login screen
   * INSIDE the session and discard the preset session id.
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

  private spawnAgent(
    sessionId: string,
    worktreePath: string,
    account: Account,
    adapter: AgentAdapter,
    args: string[],
    initial: LiveAgent['status'],
  ): void {
    try {
      this.deps.ptys.spawn(sessionId, 'agent', adapter.binary, args, {
        cwd: worktreePath,
        env: adapter.env(account),
      });
    } catch (e) {
      this.transition(sessionId, 'exited');
      this.deps.events.record(sessionId, 'spawn_failed', { message: (e as Error).message });
      throw new ApiError(
        500,
        'spawn_failed',
        `could not start ${adapter.binary}: ${(e as Error).message}`,
      );
    }
    const detector = new StatusDetector(
      adapter.statusPatterns,
      {
        onStatus: (s) => this.onDetected(sessionId, s),
        onLimitReached: () => this.deps.events.record(sessionId, 'limit_reached'),
      },
      this.deps.statusQuietMs ?? 2000,
    );
    this.liveAgents.set(sessionId, {
      detector,
      status: initial,
      lastTouch: 0,
      lastTitleCheck: 0,
      lastOscTitle: null,
    });
  }

  private onPtyData(e: PtyDataEvent): void {
    if (this.shuttingDown) return;
    const live = this.liveAgents.get(e.stream);
    if (!live) return;
    const now = Date.now();
    if (now - live.lastTouch > 1000) {
      live.lastTouch = now;
      this.deps.sessions.touchActivity(e.stream, new Date(now).toISOString());
    }
    if (e.term !== 'agent') return;
    if (live.status === 'starting') {
      live.status = 'running';
      this.transition(e.stream, 'running');
    }
    live.detector?.feed(e.data);
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
        this.refreshAgentTitle(e.stream);
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
    this.emit('renamed', {
      session: sessionId,
      title: session.title,
      agent_title: session.agent_title ?? null,
      osc_title: oscTitle,
    } satisfies RenameEvent);
  }

  private onDetected(sessionId: string, detected: DetectedStatus): void {
    const live = this.liveAgents.get(sessionId);
    if (!live || live.status === detected || live.status === 'starting') return;
    live.status = detected;
    this.transition(sessionId, detected);
    // Backstop for adoption: by waiting_input the agent has written its
    // conversation file, which was usually absent at spawn time.
    if (detected === 'waiting_input') this.scheduleAdopt(sessionId);
    // The agent's own name lands in (and updates within) the transcript as the
    // conversation progresses; pick it up on each status change.
    this.refreshAgentTitle(sessionId);
  }

  /**
   * Best-effort adopt of a session's conversation into the shared store. Runs
   * at most once successfully per session (the `adopted` set); a run that finds
   * nothing on disk yet leaves the session out so a later flip retries.
   */
  private scheduleAdopt(sessionId: string): void {
    if (!this.deps.share || this.adopted.has(sessionId)) return;
    let session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    void this.deps.share
      .adoptIfNeeded(session)
      .then((done) => {
        if (done) this.adopted.add(sessionId);
      })
      .catch((e) =>
        console.warn(`conversation adopt ${sessionId} failed: ${(e as Error).message}`),
      );
  }

  private onPtyExit(e: PtyExitEvent): void {
    if (e.term !== 'agent') return;
    const live = this.liveAgents.get(e.stream);
    if (!live) return;
    live.detector?.dispose();
    this.liveAgents.delete(e.stream);
    if (this.shuttingDown) return; // reconcile turns these into `interrupted` next boot
    this.transition(e.stream, 'exited');
    this.refreshAgentTitle(e.stream); // capture the final name for the exited/archived row
    this.deps.events.record(e.stream, 'exited', { code: e.exitCode });
  }

  private transition(id: string, status: SessionStatus): void {
    const s = this.deps.sessions.setStatus(id, status);
    this.emit('status', {
      session: id,
      status,
      last_activity_at: s.last_activity_at,
    } satisfies StatusEvent);
  }

  /** Worktree-missing badge is computed, never stored (SPEC §4). */
  private withComputed(session: Session): Session & { worktree_missing?: boolean } {
    if (session.status === 'archived') return session;
    return existsSync(session.worktree_path) ? session : { ...session, worktree_missing: true };
  }
}
