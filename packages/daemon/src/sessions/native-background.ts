import type { Session } from '@puddle/shared';
import type { SessionServiceDeps, SessionSwitchEvent } from './service.js';
import { ApiError } from '../http/errors.js';

/** A native fork can create a separate worker without moving its source TUI. */
export async function attachNativeBackground(
  deps: Pick<SessionServiceDeps, 'accounts' | 'conversations' | 'sessions' | 'runtimes' | 'events'>,
  accountId: number,
  conversationId: number,
  resume: (id: string, guard: () => void) => Promise<Session>,
  open: () => boolean,
): Promise<SessionSwitchEvent | null> {
  if (!open()) return null;
  const account = deps.accounts.get(accountId);
  const conversation = deps.conversations.get(conversationId);
  if (
    !conversation ||
    conversation.agent_type !== account.agent_type ||
    conversation.profile_id !== account.profile_id ||
    !conversation.parent_conversation_id ||
    conversation.missing
  )
    return null;
  const parent = deps.conversations.get(conversation.parent_conversation_id);
  if (!parent) return null;
  const sources = deps.conversations
    .placements(parent.id)
    .map((id) => deps.sessions.get(id))
    .filter(
      (session) =>
        session.account_id === accountId &&
        session.agent_mode === 'interactive' &&
        ['starting', 'running', 'waiting_input'].includes(session.status) &&
        session.agent_session_ref === parent.agent_session_ref &&
        deps.runtimes?.ownerOf(session.id),
    );
  if (sources.length !== 1) return null;
  const source = sources[0]!;
  const owner = deps.runtimes!.ownerOf(source.id)!;
  // Historical copies do not become new work merely because their parent resumes.
  if (
    !conversation.native_created_at ||
    Date.parse(conversation.native_created_at) < Date.parse(owner.created_at)
  )
    return null;
  const targets = deps.conversations
    .placements(conversationId)
    .map((id) => deps.sessions.get(id))
    .filter(
      (session) =>
        session.project_id === source.project_id &&
        session.account_id === accountId &&
        session.worktree_path === source.worktree_path &&
        session.agent_mode === 'interactive' &&
        session.status === 'exited',
    );
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  const guard = () => {
    const currentSource = deps.sessions.get(source.id),
      currentTarget = deps.sessions.get(target.id);
    if (
      !open() ||
      !['starting', 'running', 'waiting_input'].includes(currentSource.status) ||
      currentSource.conversation_id !== source.conversation_id ||
      deps.runtimes?.ownerOf(source.id)?.runtime_id !== owner.runtime_id ||
      currentTarget.status !== 'exited' ||
      currentTarget.conversation_id !== target.conversation_id ||
      currentTarget.account_id !== accountId ||
      deps.runtimes?.ownerOf(target.id)
    )
      throw ApiError.conflict(
        'native_background_changed',
        'The native fork changed before it could attach',
      );
  };
  guard();
  // The provider verifies the current exact job before attaching. This durable
  // intent prevents discovery/reconnect from retrying an uncertain launch.
  if (
    !deps.events.recordOnce(target.id, 'native_background_attach_requested', {
      source_session: source.id,
    })
  )
    return null;
  await resume(target.id, guard);
  return {
    sourceSession: source.id,
    targetSession: target.id,
    targetProject: target.project_id,
    cause: 'fork',
    outcome: 'focused-existing',
  };
}
