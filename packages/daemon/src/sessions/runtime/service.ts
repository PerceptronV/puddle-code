import { existsSync } from 'node:fs';
import type {
  Account,
  Session,
  SessionRuntimeInspection,
  RestartSessionRuntimeRequest,
} from '@puddle/shared';
import { assertBinaryAvailable } from '../../agents/binary.js';
import type { AgentAdapter } from '../../agents/adapter.js';
import { ApiError } from '../../http/errors.js';
import type {
  RuntimeLaunchGuard,
  RuntimeSelectedRelease,
} from '../../runtime/lifecycle/launcher.js';
import type { SessionServiceDeps } from '../service.js';
import { inspectSessionRuntime, type RestartBlocker } from './inspection.js';

type Dependencies = Pick<
  SessionServiceDeps,
  | 'sessions'
  | 'runtimes'
  | 'runtimeLauncher'
  | 'runtimeControls'
  | 'storage'
  | 'storagePaths'
  | 'adapters'
  | 'accounts'
  | 'events'
>;

/** Placement-scoped runtime maintenance; SessionService holds its lifecycle mutex for restart. */
export class SessionRuntimeService {
  constructor(
    private readonly deps: Dependencies,
    private readonly resume: (id: string, guard: RuntimeLaunchGuard) => Promise<Session>,
    private readonly checkLoggedIn: (account: Account, adapter: AgentAdapter) => Promise<void>,
  ) {}
  private restartBlocker(session: Session): RestartBlocker | null {
    if (!existsSync(session.worktree_path)) return 'worktree_missing';
    if (session.kind === 'terminal') return null;
    if (session.conversation_missing || !session.agent_session_ref) return 'conversation_unknown';
    if (!session.agent_type || !this.deps.adapters.get(session.agent_type).capabilities.resume)
      return 'resume_unsupported';
    return null;
  }

  async inspect(id: string, authorised: () => boolean): Promise<SessionRuntimeInspection> {
    if (this.deps.sessions.get(id).kind === 'huddle')
      throw ApiError.conflict(
        'huddle_control_required',
        'Use huddle lifecycle controls for this placement',
      );
    const owner = this.deps.runtimes?.ownerOf(id) ?? null;
    let release: RuntimeSelectedRelease | null = null;
    try {
      release = this.deps.runtimeLauncher?.selectedRelease() ?? null;
    } catch {
      /* Report an unavailable selector. */
    }
    let state = null;
    if (owner?.active_session_id === id && this.deps.runtimeControls) {
      try {
        state = await this.deps.runtimeControls.inspect(id, authorised);
      } catch {
        /* Keep unknown ownership protected. */
      }
    }
    if (!authorised()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    const current = this.deps.sessions.get(id);
    return inspectSessionRuntime(
      current,
      this.deps.runtimes?.ownerOf(id) ?? null,
      state,
      release,
      this.restartBlocker(current),
    );
  }

  async restart(
    id: string,
    request: RestartSessionRuntimeRequest,
    authorised: () => boolean,
  ): Promise<Session> {
    const requireAuthority = () => {
      if (!authorised())
        throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    };
    const changed = () =>
      ApiError.conflict(
        'runtime_review_changed',
        'The runtime or installed software changed. Inspect it again before restarting.',
      );
    requireAuthority();
    if (this.deps.sessions.get(id).kind === 'huddle')
      throw ApiError.conflict(
        'huddle_control_required',
        'Use huddle lifecycle controls for this placement',
      );
    const launcher = this.deps.runtimeLauncher;
    const controls = this.deps.runtimeControls;
    if (!launcher || !controls) throw changed();
    await launcher.checkAvailable();
    const session = this.deps.sessions.get(id);
    let release: RuntimeSelectedRelease | undefined;
    await this.deps.storage?.assertAdmission([
      ...(this.deps.storagePaths ?? []),
      session.worktree_path,
    ]);
    if (session.kind === 'agent') {
      if (!session.account_id || !session.agent_type) throw changed();
      const adapter = this.deps.adapters.get(session.agent_type);
      assertBinaryAvailable(adapter);
      await this.checkLoggedIn(this.deps.accounts.get(session.account_id), adapter);
    }
    requireAuthority();
    await controls.stop(id, authorised, (state) => {
      const selected = launcher.selectedRelease();
      const review = inspectSessionRuntime(
        this.deps.sessions.get(id),
        this.deps.runtimes?.ownerOf(id) ?? null,
        state,
        selected,
        this.restartBlocker(this.deps.sessions.get(id)),
      );
      if (!review.restart.available || review.restart.fingerprint !== request.fingerprint)
        throw changed();
      release = selected;
    });
    // A clean exit is committed before normal resume. A lost stop reply never
    // authorises another stop, and durable stop intent prevents boot auto-resume.
    requireAuthority();
    const beforeLaunch: RuntimeLaunchGuard = (selected) => {
      requireAuthority();
      const current = this.deps.sessions.get(id);
      if (
        JSON.stringify(selected) !== JSON.stringify(release) ||
        current.status === 'archived' ||
        current.account_id !== session.account_id ||
        current.agent_type !== session.agent_type ||
        current.agent_mode !== session.agent_mode ||
        current.project_id !== session.project_id ||
        current.agent_session_ref !== session.agent_session_ref ||
        current.worktree_path !== session.worktree_path
      )
        throw changed();
    };
    beforeLaunch(launcher.selectedRelease());
    this.deps.events.record(id, 'killed');
    return this.resume(id, beforeLaunch);
  }
}
