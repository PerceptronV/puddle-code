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
import { buildOnboardingPreamble, INTERRUPTED_RESUME_NOTE } from './onboarding.js';
import type { OnboardingNotesSync } from './onboarding.js';

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
  onboarding: OnboardingNotesSync;
  /** waiting_input quiet window; overridable for tests. */
  statusQuietMs?: number;
}

export interface StatusEvent {
  session: string;
  status: SessionStatus;
  last_activity_at: string | null;
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
 * cached status) for each live agent PTY. Emits 'status' (StatusEvent).
 */
export class SessionService extends EventEmitter {
  private readonly liveAgents = new Map<string, LiveAgent>();

  constructor(private readonly deps: SessionServiceDeps) {
    super();
    deps.ptys.on('data', (e: PtyDataEvent) => this.onPtyData(e));
    deps.ptys.on('exit', (e: PtyExitEvent) => this.onPtyExit(e));
  }

  get(id: string): Session {
    return this.withComputed(this.deps.sessions.get(id));
  }

  list(filter: { project_id?: number; status?: SessionStatus } = {}): Session[] {
    return this.deps.sessions.list(filter).map((s) => this.withComputed(s));
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

    // Permissions gate (SPEC §11): create REJECTS a denied request outright.
    const skip = this.evaluateSkip(project.profile_id, account, adapter, input.skip_permissions);
    if (input.skip_permissions === true && !skip) {
      throw ApiError.badRequest(
        'skip_permissions_denied',
        'skip_permissions requires the profile gate and the account opt-in',
      );
    }

    const sessionId = randomUUID();
    const worktree = await this.deps.worktrees.create({
      repo,
      sessionId,
      baseBranch: input.base_branch,
      requestedBranch: input.branch,
      title: input.title ?? null,
      branchPrefix: profile.branch_prefix,
    });
    const session = this.deps.sessions.create({
      id: sessionId,
      project_id: project.id,
      account_id: account.id,
      worktree_path: worktree.worktreePath,
      base_branch: worktree.baseBranch,
      branch: worktree.branch,
      agent_type: account.agent_type,
      title: input.title ?? null,
      skip_permissions: skip,
    });

    // Every freshly created worktree onboards — and only those (SPEC §4).
    const prompt = buildOnboardingPreamble(repo.onboarding_notes, input.prompt ?? null);
    const launchOpts = {
      worktreePath: worktree.worktreePath,
      sessionId,
      prompt,
      skipPermissions: skip,
    };
    this.spawnAgent(sessionId, worktree.worktreePath, account, adapter, adapter.launchArgs(launchOpts), 'starting');
    const ref = await adapter.resolveSessionRef(launchOpts, account);
    this.deps.sessions.setAgentSessionRef(sessionId, ref);
    this.deps.events.record(sessionId, 'created', {
      branch: worktree.branch,
      base_ref: worktree.baseRef,
      account_id: account.id,
      skip_permissions: skip,
    });
    this.deps.onboarding.watch(sessionId, repo.id, worktree.worktreePath);
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
      throw ApiError.conflict('worktree_missing', 'worktree is gone; the session can only be archived');
    }
    const account = this.deps.accounts.get(session.account_id);
    const project = this.deps.projects.get(session.project_id);
    const adapter = this.deps.adapters.get(session.agent_type);
    if (!adapter.capabilities.resume) {
      throw ApiError.badRequest('resume_unsupported', `${adapter.displayName} cannot resume conversations`);
    }
    const ref = session.agent_session_ref;
    if (!ref) throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');

    // Gate re-evaluated on every spawn-like action (SPEC §11.4): silent
    // downgrade with a note in the terminal, never a hard failure.
    const skip = this.evaluateSkip(project.profile_id, account, adapter, session.skip_permissions);
    const downgraded = session.skip_permissions && !skip;
    if (downgraded) this.deps.sessions.setSkipPermissions(id, false);

    const wasInterrupted = session.status === 'interrupted';
    const args = adapter.resumeArgs(ref, {
      worktreePath: session.worktree_path,
      sessionId: id,
      prompt: wasInterrupted ? INTERRUPTED_RESUME_NOTE : undefined,
      skipPermissions: skip,
    });
    this.spawnAgent(id, session.worktree_path, account, adapter, args, 'running');
    this.transition(id, 'running');
    if (downgraded) {
      this.deps.ptys.note(id, 'agent', 'skip-permissions no longer permitted; continuing with prompts on.');
    }
    this.deps.events.record(id, 'resumed', { was_interrupted: wasInterrupted, skip_permissions: skip });
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
      if (Date.now() > deadline + 2000) throw new ApiError(500, 'kill_failed', 'agent PTY refused to die');
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

  async archive(id: string, force = false): Promise<Session> {
    const session = this.deps.sessions.get(id);
    if (session.status !== 'exited' && session.status !== 'interrupted') {
      throw ApiError.conflict('session_live', 'a running session must be killed before archiving');
    }
    const project = this.deps.projects.get(session.project_id);
    const repo = this.deps.repos.get(project.repo_id);
    if (existsSync(session.worktree_path)) {
      await this.deps.worktrees.remove({ repo, worktreePath: session.worktree_path, force });
    }
    this.deps.onboarding.unwatch(id);
    this.transition(id, 'archived');
    this.deps.events.record(id, 'archived', { forced: force });
    return this.get(id);
  }

  /** Archives all sessions of a project; refuses live ones unless forced (SPEC §4). */
  async archiveProject(projectId: number, force = false): Promise<void> {
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

  /** requested ∧ profile gate ∧ account opt-in ∧ adapter capability (SPEC §11). */
  private evaluateSkip(
    profileId: number,
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
      throw new ApiError(500, 'spawn_failed', `could not start ${adapter.binary}: ${(e as Error).message}`);
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
  }

  private onPtyExit(e: PtyExitEvent): void {
    if (e.term !== 'agent') return;
    const live = this.liveAgents.get(e.stream);
    if (!live) return;
    live.detector.dispose();
    this.liveAgents.delete(e.stream);
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
