import type { Account, Session } from '@puddle/shared';
import type { AgentAdapter, LaunchOpts, SessionRefContext } from '../agents/adapter.js';
import type { ConversationStore } from '../db/stores/conversations.js';
import type { EventStore } from '../db/stores/events.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';

export interface SessionRefDeps {
  sessions: SessionStore;
  conversations: ConversationStore;
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
  /** Status/title ticks may ask for the same unresolved ref concurrently. */
  private readonly refreshes = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: SessionRefDeps) {}

  /**
   * Starts an agent and captures its native conversation ref without holding
   * the session-create response open. Preset-id agents resolve on the normal
   * create path; minted-id agents keep the snapshot → spawn → discovery
   * sequence serialised, but run that sequence in the background.
   */
  async launchAndCapture(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    launchOpts: LaunchOpts,
    spawn: () => void | Promise<void>,
    onCaptured: () => void,
    onError: (error: unknown, phase: 'spawn' | 'capture') => void,
  ): Promise<void> {
    if (adapter.capabilities.presetSessionId) {
      await spawn();
      const ref = await adapter.resolveSessionRef(launchOpts, account);
      this.deps.sessions.setAgentSessionRef(session.id, ref);
      return;
    }

    let spawned = false;
    const launch = async () => {
      const existing = await adapter.existingSessionRefs?.(session.worktree_path, account);
      await spawn();
      spawned = true;
      const ref = await adapter.resolveSessionRef(launchOpts, account, existing);
      // Minted-id adapters return the puddle id as an explicit unresolved
      // placeholder when their own state has not become visible yet. Keep the
      // durable column null: refreshAvailable() will retry from status/title
      // ticks without ever treating the placeholder as a real conversation.
      if (ref === session.id) return;
      if (await this.capture(session, account, adapter, ref, 'launch')) onCaptured();
    };
    const pending = adapter.existingSessionRefs
      ? this.launchMutex.run(
          `session-ref:${adapter.id}:${account.id}:${session.worktree_path}`,
          launch,
        )
      : launch();
    void pending.catch((error) => onError(error, spawned ? 'capture' : 'spawn'));
  }

  /**
   * Best-effort late capture after a minted conversation becomes visible.
   * Used by status changes and the periodic title refresh, which matters for
   * Codex: an empty composer may not commit its state row until the first turn.
   */
  refreshAvailable(session: Session, account: Account, adapter: AgentAdapter): Promise<boolean> {
    if (adapter.capabilities.presetSessionId || session.agent_session_ref !== null) {
      return Promise.resolve(false);
    }
    const active = this.refreshes.get(session.id);
    if (active) return active;
    const pending = this.refresh(session, account, adapter).finally(() => {
      if (this.refreshes.get(session.id) === pending) this.refreshes.delete(session.id);
    });
    this.refreshes.set(session.id, pending);
    return pending;
  }

  private async refresh(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
  ): Promise<boolean> {
    const context: SessionRefContext = {
      ...this.contextOf(session),
      excludeRefs: await this.claimedByOtherSessions(session, adapter, account),
    };
    const ref =
      (await adapter.discoverSessionRef?.(session.worktree_path, account, context)) ?? null;
    return ref === null ? false : this.capture(session, account, adapter, ref, 'late');
  }

  /**
   * Returns the ref this row may safely resume, repairing missing, duplicated,
   * or mismatched legacy mappings first. Failure is explicit: opening the
   * wrong conversation is more damaging than refusing an ambiguous resume.
   */
  async resolveForResume(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
  ): Promise<string> {
    let ref = session.agent_session_ref;
    const context: SessionRefContext = {
      ...this.contextOf(session),
      excludeRefs: await this.claimedByOtherSessions(session, adapter, account),
    };
    const missing = ref === null || (await adapter.hasConversation?.(ref, account)) === false;
    const mismatched =
      ref !== null && (await adapter.sessionRefMatches?.(ref, context, account)) === false;
    if (missing || mismatched) {
      const recovered =
        (await adapter.discoverSessionRef?.(session.worktree_path, account, context)) ?? null;
      if (recovered === null) {
        throw ApiError.conflict(
          'conversation_missing',
          `${adapter.displayName} has no conversation matching this puddle session; it cannot resume`,
        );
      }
      const previousRef = ref;
      ref = recovered;
      await this.releaseInvalidOwners(session, adapter, account, ref);
      this.deps.sessions.setAgentSessionRef(session.id, ref);
      this.deps.events.record(session.id, 'session_ref_recovered', {
        ref,
        previous_ref: previousRef,
        reason: missing ? 'missing' : 'mismatched',
      });
    }
    if (ref === null) {
      throw ApiError.conflict('no_session_ref', 'no agent session ref recorded');
    }
    return ref;
  }

  private async claimedByOtherSessions(
    session: Session,
    adapter: AgentAdapter,
    account: Account,
  ): Promise<ReadonlySet<string>> {
    const claimed = new Set<string>();
    for (const candidate of this.deps.sessions.list()) {
      const candidateRef = candidate.agent_session_ref;
      if (
        candidate.id === session.id ||
        (session.conversation_id != null &&
          candidate.conversation_id === session.conversation_id) ||
        candidate.account_id !== account.id ||
        candidateRef === null
      ) {
        continue;
      }
      if ((await adapter.hasConversation?.(candidateRef, account)) === false) continue;
      if (
        (await adapter.sessionRefMatches?.(candidateRef, this.contextOf(candidate), account)) ===
        false
      ) {
        continue;
      }
      claimed.add(candidateRef);
    }
    return claimed;
  }

  /** Clear a legacy wrong owner before the rightful session claims its ref. */
  private async releaseInvalidOwners(
    session: Session,
    adapter: AgentAdapter,
    account: Account,
    recoveredRef: string,
  ): Promise<void> {
    for (const candidate of this.deps.sessions.list()) {
      if (
        candidate.id === session.id ||
        (session.conversation_id != null &&
          candidate.conversation_id === session.conversation_id) ||
        candidate.account_id !== account.id ||
        candidate.agent_session_ref !== recoveredRef
      ) {
        continue;
      }
      if (
        (await adapter.sessionRefMatches?.(recoveredRef, this.contextOf(candidate), account)) !==
        false
      ) {
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

  /** Validate and durably claim a newly discovered minted ref exactly once. */
  private async capture(
    session: Session,
    account: Account,
    adapter: AgentAdapter,
    ref: string,
    source: 'launch' | 'late',
  ): Promise<boolean> {
    const current = this.deps.sessions.get(session.id);
    if (current.agent_session_ref === ref) return false;
    if (current.agent_session_ref !== null) return false;
    const context: SessionRefContext = {
      ...this.contextOf(current),
      excludeRefs: await this.claimedByOtherSessions(current, adapter, account),
    };
    // The serialised launch snapshot proves ownership already. Late recovery
    // has no such single-launch proof, so it must pass the adapter's stricter
    // cwd + creation-time match before claiming anything.
    if (source === 'late' && (await adapter.sessionRefMatches?.(ref, context, account)) === false) {
      return false;
    }
    await this.releaseInvalidOwners(current, adapter, account, ref);
    this.deps.sessions.setAgentSessionRef(current.id, ref);
    this.deps.events.record(current.id, 'session_ref_captured', { ref, source });
    return true;
  }

  private contextOf(session: Session): SessionRefContext {
    const nativeCreatedAt =
      session.conversation_id == null
        ? null
        : (this.deps.conversations.get(session.conversation_id)?.native_created_at ?? null);
    return {
      sessionId: session.id,
      worktreePath: session.worktree_path,
      createdAt: session.created_at,
      ...(nativeCreatedAt === null ? {} : { nativeCreatedAt }),
    };
  }
}
