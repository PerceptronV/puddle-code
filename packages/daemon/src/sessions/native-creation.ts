import type { SessionServiceDeps, SessionSwitchEvent } from './service.js';
import { ApiError } from '../http/errors.js';

/** A native new/clear/fork moves the TUI; keep its saved source independently live. */
export async function preserveNativeSource(
  deps: Pick<SessionServiceDeps, 'sessions' | 'events' | 'runtimes' | 'runtimeSwitchSettled'>,
  event: SessionSwitchEvent,
  resume: (id: string, guard: () => void) => Promise<unknown>,
  open: () => boolean,
): Promise<void> {
  if (event.outcome !== 'rebound' || !['clear', 'fork'].includes(event.cause) || !open()) return;
  const source = deps.sessions.get(event.sourceSession);
  if (source.status !== 'exited' || !source.agent_session_ref || !source.conversation_id) return;
  const target = deps.sessions.get(event.targetSession);
  if (source.conversation_id === target.conversation_id) return;
  if (event.cause === 'fork' && target.parent_conversation_id !== source.conversation_id) return;
  const owner = deps.runtimes?.ownerOf(target.id);
  if (owner) {
    if (!deps.runtimeSwitchSettled || !(await deps.runtimeSwitchSettled(owner.runtime_id)))
      throw new Error('The new conversation has not confirmed its runtime placement');
  }
  const guard = () => {
    const current = deps.sessions.get(source.id);
    if (
      !open() ||
      current.status !== 'exited' ||
      current.conversation_id !== source.conversation_id ||
      current.agent_session_ref !== source.agent_session_ref ||
      deps.runtimes?.ownerOf(source.id)
    )
      throw ApiError.conflict(
        'native_source_changed',
        'The original conversation changed before it could resume',
      );
  };
  guard();
  // Persist intent before invoking the ordinary one-shot launcher. Duplicate
  // notifications or lost replies must not create another owner.
  if (
    !deps.events.recordOnce(source.id, 'native_source_resume_requested', {
      target_session: target.id,
      cause: event.cause,
    })
  )
    return;
  await resume(source.id, guard);
}
