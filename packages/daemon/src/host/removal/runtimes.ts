import type { RuntimeState } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { RuntimeBinding, RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeControls } from '../../runtime/controller/controls.js';
import { runtimeBindingIdentity } from '../../runtime/transport/connections.js';

export const HOST_REMOVAL_RUNTIME_LIMIT = 1024;
type Authority = () => boolean;

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

function inventory(rows: RuntimeBinding[]): string {
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
        }))
        .sort((a, b) => a.identity.runtime_id.localeCompare(b.identity.runtime_id)),
    ),
  );
}

function inspect(
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
              owner: inventory([owner]),
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

/**
 * Runtime disposition for host removal, reusing the ordinary control queue and
 * durable stop intent. The host coordinator must fence new launches throughout
 * application; this component neither stops the daemon nor removes its files.
 */
export class HostRuntimeRemoval {
  constructor(
    private readonly deps: {
      runtimes: Pick<RuntimeStore, 'live' | 'get' | 'stopRequested'>;
      controls: Pick<RuntimeControls, 'inspect' | 'stop'>;
    },
  ) {}

  private requireAuthority(authorised: Authority): void {
    if (!authorised()) throw new Error('Host removal authority expired');
  }

  private live(): RuntimeBinding[] {
    const rows = this.deps.runtimes.live(HOST_REMOVAL_RUNTIME_LIMIT + 1);
    if (rows.length > HOST_REMOVAL_RUNTIME_LIMIT)
      throw new Error('Host removal runtime inventory exceeds its limit');
    return rows;
  }

  async review(authorised: Authority): Promise<RuntimeRemovalReview> {
    this.requireAuthority(authorised);
    const rows = this.live();
    const before = inventory(rows);
    const owners: RuntimeRemovalOwner[] = new Array(rows.length);
    let index = 0;
    const inspected = await Promise.allSettled(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (index < rows.length) {
          this.requireAuthority(authorised);
          const position = index++;
          const row = rows[position]!;
          let state: RuntimeState | null = null;
          try {
            state = await this.deps.controls.inspect(row.active_session_id, authorised);
          } catch {
            // Unknown owners can be retained, but cannot be assumed safe to stop or delete.
          }
          this.requireAuthority(authorised);
          owners[position] = inspect(row, state, this.deps.runtimes.stopRequested(row.runtime_id));
        }
      }),
    );
    const failed = inspected.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    this.requireAuthority(authorised);
    if (inventory(this.live()) !== before)
      throw new Error('Runtime inventory changed during removal review');
    return { inventory: before, owners };
  }

  /** Explicit disposition only. A pending stop is observed elsewhere, never sent again here. */
  async apply(
    review: RuntimeRemovalReview,
    disposition: 'retain' | 'stop',
    authorised: Authority,
  ): Promise<void> {
    this.requireAuthority(authorised);
    if (disposition !== 'retain' && disposition !== 'stop')
      throw new Error('Unknown runtime disposition');
    const current = await this.review(authorised);
    if (
      current.inventory !== review.inventory ||
      JSON.stringify(current.owners) !== JSON.stringify(review.owners)
    )
      throw new Error('Runtime removal review changed');
    if (disposition === 'retain') return;
    if (current.owners.some((owner) => !('fingerprint' in owner.stop)))
      throw new Error('Runtime removal requires resolved stop and persistence state');
    const remaining = new Set(current.owners.map((owner) => owner.id));
    for (const expected of current.owners) {
      this.requireAuthority(authorised);
      const rows = this.live();
      if (rows.length !== remaining.size || rows.some((row) => !remaining.has(row.runtime_id)))
        throw new Error('Runtime inventory changed during removal');
      await this.deps.controls.stop(expected.session, authorised, (state) => {
        this.requireAuthority(authorised);
        const owner = this.deps.runtimes.get(expected.id);
        if (!owner || !remaining.has(owner.runtime_id))
          throw new Error('Runtime removal owner changed');
        const observed = inspect(owner, state, this.deps.runtimes.stopRequested(owner.runtime_id));
        if (JSON.stringify(observed) !== JSON.stringify(expected))
          throw new Error('Runtime removal impact changed');
      });
      remaining.delete(expected.id);
    }
    this.requireAuthority(authorised);
    if (this.live().length) throw new Error('Live runtimes remain after removal stops');
  }
}
