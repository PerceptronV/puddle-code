import { randomUUID } from 'node:crypto';
import {
  filetreeHuddleTrigger,
  huddleFiletreeStateSchema,
  huddleFiletreeSnapshotSchema,
  HUDDLE_FILETREE_LIMITS,
  type HuddleFiletreeSnapshot,
  type HuddleDefinition,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import { HuddleStateDatabase } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import { filetreeChanges } from '../triggers/filetree/snapshot.js';
import type { FiletreeDefinition } from '../triggers/filetree/definitions.js';

/** Eight reusable slots bound retained source state across graph revisions. */
export class HuddleFiletrees {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}
  current(slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HUDDLE_FILETREE_LIMITS.sources)
      throw new Error('Invalid Filetree source slot');
    const row = this.db.get('filetrees', String(slot));
    return row ? huddleFiletreeStateSchema.parse(JSON.parse(row.body)) : null;
  }
  initialise(
    definition: FiletreeDefinition,
    activation: HuddleRevisionActivation,
    snapshot: HuddleFiletreeSnapshot,
  ) {
    return this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for Filetree admission');
      const existing = this.current(definition.slot);
      if (
        existing?.generation === control.generation &&
        existing.activationId === activation.id &&
        existing.node === definition.node
      )
        return existing;
      const state = huddleFiletreeStateSchema.parse({
        node: definition.node,
        activationId: activation.id,
        generation: control.generation,
        worktree: definition.worktree,
        snapshot,
        sequence: 0,
        pending: null,
      });
      this.db.put('filetrees', String(definition.slot), activation.id, 'current', state, {
        bytes: 4096,
      });
      return state;
    });
  }
  private active(slot: number, generation: number) {
    const state = this.current(slot),
      control = this.activations.current();
    if (
      !state ||
      state.generation !== generation ||
      control.generation !== generation ||
      control.state !== 'armed' ||
      control.activationId !== state.activationId
    )
      throw new Error('Filetree activation changed');
    return state;
  }
  capture(slot: number, generation: number, snapshot: HuddleFiletreeSnapshot, now: number) {
    const next = huddleFiletreeSnapshotSchema.parse(snapshot);
    return this.db.atomic(() => {
      const state = this.active(slot, generation);
      if (state.pending)
        throw new Error('Admit the retained Filetree observation before replacing it');
      if (!filetreeChanges(state.snapshot, next).length) return false;
      state.pending = { snapshot: next, observedAt: new Date(now).toISOString(), batch: 0 };
      this.db.put('filetrees', String(slot), state.activationId, 'current', state, { bytes: 4096 });
      return true;
    });
  }
  admit(slot: number, generation: number, limits: HuddleDefinition['execution'], now: number) {
    return this.db.atomic(() => {
      const state = this.active(slot, generation);
      if (!state.pending) return null;
      const changes = filetreeChanges(state.snapshot, state.pending.snapshot);
      const offset = state.pending.batch * HUDDLE_FILETREE_LIMITS.changes;
      const batch = changes.slice(offset, offset + HUDDLE_FILETREE_LIMITS.changes),
        final = offset + batch.length === changes.length;
      if (!batch.length) throw new Error('Retained Filetree observation has no changes');
      const activation = this.activations.get(state.activationId),
        sequence = state.sequence + 1;
      const event = {
        format: 1 as const,
        id: `${activation.id}:${generation}:${sequence}`,
        source: { node: state.node, component: filetreeHuddleTrigger.id, version: 1 },
        port: 'event',
        observedAt: new Date(now).toISOString(),
        scope: this.db.identity,
        revision: activation.revision,
        executionId: randomUUID(),
        resource: { kind: 'worktree' as const, worktree: state.worktree },
        // No occurredAt: filesystem notifications do not establish exact edit times.
        data: {
          changes: batch,
          reconciled: true,
          observedAt: state.pending.observedAt,
          batch: state.pending.batch + 1,
          final,
        },
      };
      const accepted = this.executions.accept(
        event,
        this.executions.cursor(this.executions.sourceKey(event)),
        { generation, sequence },
        limits,
        now,
        activation.id,
      );
      state.sequence = sequence;
      if (final) {
        state.snapshot = state.pending.snapshot;
        state.pending = null;
      } else state.pending.batch++;
      this.db.put('filetrees', String(slot), activation.id, 'current', state, { bytes: 4096 });
      return accepted;
    });
  }
}
