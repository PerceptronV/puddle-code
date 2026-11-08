import {
  HOST_REMOVAL_RUNTIME_LIMIT,
  type RuntimeState,
  type HuddleOwnerState,
} from '@puddle/shared';
import type { RuntimeBinding, RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeControls } from '../../runtime/controller/controls.js';
import {
  removalRuntimeInventory as inventory,
  inspectSessionRemoval as inspect,
  type RuntimeRemovalOwner,
  type RuntimeRemovalReview,
} from './runtimes/inspection.js';
import { inspectHuddleRemoval } from './runtimes/huddle.js';

type Authority = () => boolean;

/**
 * Runtime disposition for host removal, reusing the ordinary control queue and
 * durable stop intent. The host coordinator must fence new launches throughout
 * application; this component neither stops the daemon nor removes its files.
 */
export class HostRuntimeRemoval {
  constructor(
    private readonly deps: {
      runtimes: Pick<RuntimeStore, 'live' | 'get' | 'stopRequested'>;
      controls: Pick<RuntimeControls, 'inspect' | 'stop'> &
        Partial<Pick<RuntimeControls, 'huddles'>>;
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
          if (row.role === 'huddle') {
            let state: HuddleOwnerState | null = null;
            try {
              state =
                (await this.deps.controls.huddles?.inspect(row.active_session_id, authorised)) ??
                null;
            } catch {
              /* Retain unavailable owners; never infer stop authority. */
            }
            this.requireAuthority(authorised);
            owners[position] = inspectHuddleRemoval(
              row,
              state,
              this.deps.runtimes.stopRequested(row.runtime_id),
            );
            continue;
          }
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
      const target = rows.find((row) => row.runtime_id === expected.id)!;
      if (target.role === 'huddle') {
        if (!this.deps.controls.huddles) throw new Error('Huddle control unavailable');
        await this.deps.controls.huddles.stop(expected.session, authorised, (state) => {
          this.requireAuthority(authorised);
          const owner = this.deps.runtimes.get(expected.id);
          if (!owner || owner.role !== 'huddle') throw new Error('Huddle removal owner changed');
          const observed = inspectHuddleRemoval(
            owner,
            state,
            this.deps.runtimes.stopRequested(owner.runtime_id),
          );
          if (JSON.stringify(observed) !== JSON.stringify(expected))
            throw new Error('Huddle removal impact changed');
        });
        remaining.delete(expected.id);
        continue;
      }
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
