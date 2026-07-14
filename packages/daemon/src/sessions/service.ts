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
import type { PtyDataEvent, PtyExitEvent, PtyManager } from '../pty/pty-manager.js';
import { StatusDetector, type DetectedStatus } from '../pty/status-detector.js';
import type { WorktreeManager } from '../worktrees/manager.js';
import type { ConversationShare } from './conversation-share.js';
import { buildOnboardingPreamble, INTERRUPTED_RESUME_NOTE } from './onboarding.js';
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
  /** waiting_input quiet window; overridable for tests. */
  statusQuietMs?: number;
}

export interface StatusEvent {
  session: string;
  status: SessionStatus;
  last_activity_at: string | null;
}

export interface RenameEvent {
  session: string;
  title: string | null;
}

interface LiveAgent {
  detector: StatusDetector;
  status: Extract<SessionStatus, 'starting' | 'running' | 'waiting_input'>;
  lastTouch: number;
}

const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting_input'];

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

  constructor(private readonly deps: SessionServiceDeps) {
    super();
    deps.ptys.on('data', (e: PtyDataEvent) => this.onPtyData(e));
    deps.ptys.on('exit', (e: PtyExitEvent) => this.onPtyExit(e));
  }

  /**
   * Daemon shutdown: PTYs are about to be killed, but their sessions must
   * KEEP their live status rows — the next boot's reconcile pass turns them
   * into `interrupted` (SPEC §4). Without this, the exit handlers would
   * record a graceful `exited` and the restart AT would lie.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  get(id: string): Session {
    return this.withComputed(this.deps.sessions.get(id));
  }

  list(filter: { project_id?: string; status?: SessionStatus } = {}): Session[] {
    return this.deps.sessions.list(filter).map((s) => this.withComputed(s));
  }

  /** Renames the puddle session only — the git branch is untouched (SPEC §6). */
  rename(id: string, title: string): Session {
    this.deps.sessions.get(id);
    this.deps.sessions.setTitle(id, title);
    const session = this.get(id);
    this.emit('renamed', { session: id, title: session.title } satisfies RenameEvent);
    return session;
  }

  /**
   * Applies a title the agent chose for itself via `.puddle/session-title`
   * (MarkerFileSync). Same broadcast path as a user rename, so every attached
   * client sees the new name live — no refetch needed.
   */
  applyAgentTitle(id: string, title: string): void {
    this.deps.sessions.setTitle(id, title);
    this.emit('renamed', { session: id, title } satisfies RenameEvent);
  }

  async create(input: CreateSessionRequest): Promise<Session> {
    const project = this.deps.projects.get(input.project_id);
    const profile = this.deps.profiles.get(project.profile_id);
    const repo = this.deps.repos.get(project.repo_id);
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
    if (!separateBranch && input.branch !== undefined) {
      throw ApiError.badRequest(
        'branch_with_shared',
        'a session without a separate branch works directly on the base branch; omit branch',
      );
    }
    const sessionId = randomUUID();
    const worktree = separateBranch
      ? await this.deps.worktrees.create({
          repo,
          sessionId,
          baseBranch: input.base_branch,
          requestedBranch: input.branch,
          title: input.title ?? null,
          prompt: input.prompt ?? null,
          branchPrefix: profile.branch_prefix,
        })
      : await this.deps.worktrees.attachShared({ repo, baseBranch: input.base_branch });
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: account.id,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      separate_branch: separateBranch,
      agent_type: account.agent_type,
      title: input.title ?? null,
      skip_permissions: skip,
    });

    // Every freshly created worktree onboards — and only those (SPEC §4).
    // Attaching to an existing shared worktree is a reuse, like a hand-off:
    // the environment already exists, so the user's prompt goes in bare.
    const prompt = worktree.created
      ? buildOnboardingPreamble(repo.onboarding_notes, input.prompt ?? null)
      : (input.prompt ?? undefined);
    const launchOpts = {
      worktreePath: worktree.worktreePath,
      sessionId,
      prompt,
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
    const args = adapter.resumeArgs(ref, {
      worktreePath: session.worktree_path,
      sessionId: session.id,
      prompt: opts.interruptedNote ? INTERRUPTED_RESUME_NOTE : undefined,
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
    const adapter = this.deps.adapters.get(session.agent_type);
    // A live session is stopped first — usually it has already exited (credit
    // exhaustion). kill() waits for the PTY to die before returning.
    if (LIVE_STATUSES.includes(session.status)) await this.kill(id);
    // The target must be logged in — the same probe create/resume use.
    await this.assertLoggedIn(target, adapter);

    const ref = session.agent_session_ref;
    if (!ref) throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');

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

  async archive(id: string, force = false, deleteBranch = false): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status !== 'exited' && session.status !== 'interrupted') {
      throw ApiError.conflict('session_live', 'a running session must be killed before archiving');
    }
    if (deleteBranch && !session.separate_branch) {
      throw ApiError.badRequest(
        'branch_not_owned',
        `this session works directly on ${session.branch}; puddle only deletes branches it created`,
      );
    }
    const project = this.deps.projects.get(session.project_id);
    const repo = this.deps.repos.get(project.repo_id);
    // A shared worktree outlives this session while any other non-archived
    // session is attached to it (SPEC §4); the last one out removes it.
    const lastUser = this.deps.sessions.countOtherActiveOnWorktree(session.worktree_path, id) === 0;
    if (lastUser && existsSync(session.worktree_path)) {
      await this.deps.worktrees.remove({ repo, worktreePath: session.worktree_path, force });
    }
    if (deleteBranch) {
      // After worktree removal — git refuses to delete a checked-out branch.
      try {
        await this.deps.worktrees.deleteBranch(repo, session.branch);
      } catch (e) {
        throw ApiError.conflict(
          'branch_delete_failed',
          `could not delete branch ${session.branch}: ${(e as Error).message}; archive again without deleting to keep it`,
        );
      }
    }
    this.deps.onboarding.unwatch(id);
    // Delete this session's own conversation files from the shared store; a
    // canonical dir that is left empty (and its symlinks) go with it.
    if (this.deps.share) {
      try {
        await this.deps.share.removeSessionData(session);
      } catch (e) {
        console.warn(`conversation cleanup ${id} failed: ${(e as Error).message}`);
      }
    }
    this.adopted.delete(id);
    this.transition(id, 'archived');
    this.deps.events.record(id, 'archived', { forced: force, branch_deleted: deleteBranch });
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
      if (s.status !== 'archived') await this.archive(s.id, force);
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
    this.liveAgents.set(sessionId, { detector, status: initial, lastTouch: 0 });
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
    live.detector.feed(e.data);
  }

  private onDetected(sessionId: string, detected: DetectedStatus): void {
    const live = this.liveAgents.get(sessionId);
    if (!live || live.status === detected || live.status === 'starting') return;
    live.status = detected;
    this.transition(sessionId, detected);
    // Backstop for adoption: by waiting_input the agent has written its
    // conversation file, which was usually absent at spawn time.
    if (detected === 'waiting_input') this.scheduleAdopt(sessionId);
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
    live.detector.dispose();
    this.liveAgents.delete(e.stream);
    if (this.shuttingDown) return; // reconcile turns these into `interrupted` next boot
    this.transition(e.stream, 'exited');
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
