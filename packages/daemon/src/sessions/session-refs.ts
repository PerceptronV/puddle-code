import type { Account, Session } from '@puddle/shared';
import type { AgentAdapter, LaunchOpts, SessionRefContext } from '../agents/adapter.js';
import type { EventStore } from '../db/stores/events.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';

export interface SessionRefDeps {
  sessions: SessionStore;
  events: EventStore;
}

/**
 * Owns the one-to-one mapping between puddle sessions and agent-native refs.
 * Agent-specific storage inspection stays behind adapter hooks; this class
 * only coordinates snapshots, serialisation, validation, and durable repair.
 */
export class SessionRefs {
  /** Minted refs must be captured one launch at a time per account/cwd. */
  private readonly launchMutex = new KeyedMutex();

  constructor(private readonly deps: SessionRefDeps) {}

  resolveOnLaunch(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    launchOpts: LaunchOpts,
    spawn: () => void,
  ): Promise<string> {
    const launch = async () => {
      const existing = adapter.existingSessionRefs?.(session.worktree_path, account);
      spawn();
      return adapter.resolveSessionRef(launchOpts, account, existing);
    };
    if (!adapter.existingSessionRefs) return launch();
    return this.launchMutex.run(
      `session-ref:${adapter.id}:${account.id}:${session.worktree_path}`,
      launch,
    );
  }

  /**
   * Returns the ref this row may safely resume, repairing missing, duplicated,
   * or mismatched legacy mappings first. Failure is explicit: opening the
   * wrong conversation is more damaging than refusing an ambiguous resume.
   */
  resolveForResume(session: Session, account: Account, adapter: AgentAdapter): string {
    let ref = session.agent_session_ref;
    const context: SessionRefContext = {
      ...this.contextOf(session),
      excludeRefs: this.claimedByOtherSessions(session, adapter, account),
    };
    const duplicated =
      ref !== null &&
      this.deps.sessions
        .list()
        .some(
          (candidate) =>
            candidate.id !== session.id &&
            candidate.account_id === account.id &&
            candidate.agent_session_ref === ref,
        );
    const missing = ref === null || adapter.hasConversation?.(ref, account) === false;
    const mismatched = ref !== null && adapter.sessionRefMatches?.(ref, context, account) === false;
    if (missing || duplicated || mismatched) {
      const recovered =
        adapter.discoverSessionRef?.(session.worktree_path, account, context) ?? null;
      if (recovered === null) {
        throw ApiError.conflict(
          'conversation_missing',
          `${adapter.displayName} has no conversation matching this puddle session; it cannot resume`,
        );
      }
      const previousRef = ref;
      ref = recovered;
      this.releaseInvalidOwners(session, adapter, account, ref);
      this.deps.sessions.setAgentSessionRef(session.id, ref);
      this.deps.events.record(session.id, 'session_ref_recovered', {
        ref,
        previous_ref: previousRef,
        reason: missing ? 'missing' : duplicated ? 'duplicated' : 'mismatched',
      });
    }
    if (ref === null) {
      throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');
    }
    return ref;
  }

  private claimedByOtherSessions(
    session: Session,
    adapter: AgentAdapter,
    account: Account,
  ): ReadonlySet<string> {
    const claimed = new Set<string>();
    for (const candidate of this.deps.sessions.list()) {
      const candidateRef = candidate.agent_session_ref;
      if (
        candidate.id === session.id ||
        candidate.account_id !== account.id ||
        candidateRef === null
      ) {
        continue;
      }
      if (adapter.hasConversation?.(candidateRef, account) === false) continue;
      if (adapter.sessionRefMatches?.(candidateRef, this.contextOf(candidate), account) === false) {
        continue;
      }
      claimed.add(candidateRef);
    }
    return claimed;
  }

  /** Clear a legacy wrong owner before the rightful session claims its ref. */
  private releaseInvalidOwners(
    session: Session,
    adapter: AgentAdapter,
    account: Account,
    recoveredRef: string,
  ): void {
    for (const candidate of this.deps.sessions.list()) {
      if (
        candidate.id === session.id ||
        candidate.account_id !== account.id ||
        candidate.agent_session_ref !== recoveredRef
      ) {
        continue;
      }
      if (adapter.sessionRefMatches?.(recoveredRef, this.contextOf(candidate), account) !== false) {
        throw ApiError.conflict(
          'conversation_claimed',
          `${adapter.displayName} conversation ${recoveredRef} belongs to another puddle session`,
        );
      }
      this.deps.sessions.setAgentSessionRef(candidate.id, null);
      this.deps.events.record(candidate.id, 'session_ref_invalidated', {
        ref: recoveredRef,
        claimed_by: session.id,
      });
    }
  }

  private contextOf(session: Session): SessionRefContext {
    return {
      sessionId: session.id,
      worktreePath: session.worktree_path,
      createdAt: session.created_at,
    };
  }
}
