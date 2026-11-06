import type { Account, Session } from '@puddle/shared';
import type { AgentAdapter } from '../agents/adapter.js';
import { HostBackgroundTasks } from '../host/lifecycle/background.js';
import type { RuntimePersistence } from '../storage/runtime-persistence.js';
import { SessionRefs } from './session-refs.js';
import type { RenameEvent, SessionServiceDeps } from './service.js';

type IdentityDeps = Pick<
  SessionServiceDeps,
  'sessions' | 'accounts' | 'adapters' | 'conversations' | 'events' | 'share' | 'storage'
>;

/** Native reference capture, titles and shared-store adoption, independent of PTY ownership. */
export class SessionIdentity {
  readonly refs: SessionRefs;
  private readonly adopted = new Set<string>();
  private readonly adoptions = new HostBackgroundTasks();
  private shuttingDown = false;
  constructor(
    private readonly deps: IdentityDeps,
    private readonly persistence: RuntimePersistence,
    private readonly onBound: (session: string) => void,
    private readonly renamed: (event: RenameEvent) => void,
  ) {
    this.refs = new SessionRefs(deps);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.refs.beginShutdown();
    this.adoptions.beginShutdown();
  }
  async drain(): Promise<void> {
    this.beginShutdown();
    await Promise.all([this.refs.close(), this.adoptions.close()]);
  }
  pauseCapture() {
    return this.refs.pause();
  }
  pauseAdoption() {
    return this.adoptions.pause();
  }
  forget(session: string): void {
    this.adopted.delete(session);
  }

  /**
   * Captures a minted conversation ref once it becomes visible, then refreshes
   * the independent human-readable agent name. Codex keeps its stable UUID in
   * `agent_session_ref` while `/rename` only changes the conversation's native
   * title; every placement reads that title through the store join.
   */
  refreshAgentIdentity(sessionId: string): void {
    if (this.shuttingDown) return;
    let session: Session;
    let account: Account;
    let adapter: AgentAdapter;
    try {
      session = this.deps.sessions.get(sessionId);
      if (session.kind !== 'agent' || session.account_id === null) return;
      account = this.deps.accounts.get(session.account_id);
      adapter = this.deps.adapters.get(session.agent_type ?? account.agent_type);
    } catch {
      return; // best-effort identity refresh; title refresh follows the same rule
    }
    void (
      session.agent_mode === 'headless'
        ? Promise.resolve(false)
        : this.refs.refreshAvailable(session, account, adapter)
    )
      .catch((error: unknown) => {
        this.deps.storage?.noteFailure(error);
        return false;
      })
      .then(() =>
        this.persistence.observe(() => {
          if (this.shuttingDown) return;
          this.onBound(sessionId);
          this.refreshAgentTitle(sessionId);
        }),
      );
  }

  /**
   * Re-reads the agent's own session name (adapter.sessionTitle) and, when it
   * changed, stores it on the native conversation and broadcasts — so an
   * attached client's joined `agent_title` tracks the agent live (a placement
   * user override still wins).
   * Best-effort: hooked off status changes and exit, and never throws upward.
   */
  refreshAgentTitle(sessionId: string): void {
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
    this.renamed({
      session: sessionId,
      title: session.title,
      agent_title: next,
      osc_title: session.osc_title ?? null,
    } satisfies RenameEvent);
  }

  /**
   * Best-effort adopt of a session's conversation into the shared store. Runs
   * at most once successfully per session (the `adopted` set); a run that finds
   * nothing on disk yet leaves the session out so a later flip retries.
   */
  scheduleAdopt(sessionId: string): void {
    const share = this.deps.share;
    if (this.shuttingDown || !share || this.adopted.has(sessionId)) return;
    let session;
    try {
      session = this.deps.sessions.get(sessionId);
    } catch {
      return; // session gone
    }
    this.adoptions.start(`conversation-adopt:${sessionId}`, async () => {
      if (await share.adoptIfNeeded(session)) this.adopted.add(sessionId);
    });
  }
}
