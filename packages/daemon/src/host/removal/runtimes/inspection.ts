import type { RuntimeState } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';

export interface RuntimeRemovalOwner {
  id: string;
  session: string;
  version: string;
  release: string;
  terminals: string[] | null;
  stop: { fingerprint: string } | { reason: 'unavailable' | 'unsaved' | 'stop_pending' };
}

/** Private host review. It is never sufficient authority to delete files or purge a home. */
export interface RuntimeRemovalReview {
  inventory: string;
  owners: RuntimeRemovalOwner[];
}

export function removalRuntimeInventory(rows: RuntimeBinding[]): string {
  return digest(
    JSON.stringify(
      rows
        .map((row) => ({
          identity: runtimeBindingIdentity(row),
          session: row.active_session_id,
          segment: row.active_segment_id,
          conversation: row.conversation_id,
          account: row.account_id,
          build: row.build,
          protocol: [row.protocol_major, row.protocol_minor],
          release: row.release_path,
          state: row.state,
          ...(row.role === 'huddle' ? { huddle: [row.huddle_id, row.huddle_capabilities] } : {}),
        }))
        .sort((a, b) => a.identity.runtime_id.localeCompare(b.identity.runtime_id)),
    ),
  );
}

export function inspectSessionRemoval(
  owner: RuntimeBinding,
  state: RuntimeState | null,
  requested: boolean,
): RuntimeRemovalOwner {
  let reason: 'unavailable' | 'unsaved' | 'stop_pending' | null = null;
  if (requested) reason = 'stop_pending';
  else if (
    !state ||
    state.state !== 'running' ||
    JSON.stringify(state.identity) !== JSON.stringify(runtimeBindingIdentity(owner)) ||
    state.build !== owner.build ||
    state.protocol.major !== owner.protocol_major ||
    state.protocol.minor !== owner.protocol_minor ||
    state.binding?.session_id !== owner.active_session_id ||
    state.binding.segment_id !== owner.active_segment_id ||
    state.history.current.id !== owner.active_segment_id
  )
    reason = 'unavailable';
  else if (
    state.persistence_pending ||
    state.journal.persistence_pending ||
    state.history.gap ||
    state.history.pending_checkpoints
  )
    reason = 'unsaved';
  const terminals =
    state?.terminals
      .filter((term) => term.exit_code === null)
      .map(({ term, generation }) => ({ term, generation }))
      .sort((a, b) => a.term.localeCompare(b.term)) ?? null;
  return {
    id: owner.runtime_id,
    session: owner.active_session_id,
    version: owner.build,
    release: owner.release_path,
    terminals: terminals?.map(({ term }) => term) ?? null,
    stop: reason
      ? { reason }
      : {
          fingerprint: digest(
            JSON.stringify({
              owner: removalRuntimeInventory([owner]),
              // Acknowledgement progress is not a change to interruption impact.
              binding: {
                session_id: state!.binding!.session_id,
                segment_id: state!.binding!.segment_id,
              },
              terminals,
              conversation: state!.agent?.agent_session_ref ?? null,
              segmentConversation: state!.history.current.agent_session_ref,
            }),
          ),
        },
  };
}
