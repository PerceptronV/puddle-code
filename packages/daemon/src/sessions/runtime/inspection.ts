import type { RuntimeState, Session, SessionRuntimeInspection } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../db/stores/runtimes.js';
import type { RuntimeSelectedRelease } from '../../runtime/lifecycle/launcher.js';

export type RestartBlocker = Extract<
  SessionRuntimeInspection['restart'],
  { available: false }
>['reason'];

/** Stable impact, excluding terminal output, sizes, status and environment values. */
export function inspectSessionRuntime(
  session: Session,
  owner: RuntimeBinding | null,
  state: RuntimeState | null,
  release: RuntimeSelectedRelease | null,
  blocker: RestartBlocker | null,
): SessionRuntimeInspection {
  const current = owner?.active_session_id === session.id ? owner : null;
  const terms = state?.terminals.filter((term) => term.exit_code === null) ?? null;
  let reason = blocker;
  if (!current) reason = owner ? 'runtime_changed' : 'no_live_runtime';
  else if (!state || state.state !== 'running') reason = 'runtime_unavailable';
  else if (state.identity.runtime_id !== current.runtime_id) reason = 'runtime_changed';
  else if (!release) reason = 'release_unavailable';
  else if (state.persistence_pending || state.history.gap || state.history.pending_checkpoints > 0)
    reason = 'state_not_saved';
  else if (
    state.binding?.session_id !== session.id ||
    state.binding.segment_id !== current.active_segment_id ||
    state.history.current.id !== current.active_segment_id
  )
    reason = 'runtime_changed';
  else if (
    session.kind === 'agent' &&
    (!session.agent_session_ref ||
      state.agent?.agent_session_ref !== session.agent_session_ref ||
      state.history.current.agent_session_ref !== session.agent_session_ref)
  )
    reason = 'conversation_unknown';
  return {
    runtime: current
      ? {
          id: current.runtime_id,
          version: current.build,
          protocol: { major: current.protocol_major, minor: current.protocol_minor },
          connected: state !== null,
          terminals: terms?.map(({ term }) => ({ term })) ?? null,
        }
      : null,
    installed: release ? { version: release.build, protocol: release.protocol } : null,
    restart: reason
      ? { available: false, reason }
      : {
          available: true,
          fingerprint: digest(
            JSON.stringify({
              runtime: state!.identity,
              binding: state!.binding,
              source: {
                build: current!.build,
                protocol: [current!.protocol_major, current!.protocol_minor],
              },
              target: release,
              session: {
                id: session.id,
                project: session.project_id,
                account: session.account_id,
                ref: session.agent_session_ref,
                mode: session.agent_mode,
                worktree: session.worktree_path,
              },
              terminals: terms!
                .map(({ term, generation }) => ({ term, generation }))
                .sort((a, b) => a.term.localeCompare(b.term)),
            }),
          ),
        },
  };
}
