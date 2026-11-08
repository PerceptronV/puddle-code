import { randomUUID } from 'node:crypto';
import {
  gitHuddleTrigger,
  huddleGitStateSchema,
  huddleGitSnapshotSchema,
  HUDDLE_GIT_LIMITS,
  type HuddleGitSnapshot,
  type HuddleDefinition,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import { HuddleStateDatabase } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleActivations } from './activation.js';
import { gitChanges } from '../triggers/git/changes.js';
import type { GitDefinition } from '../triggers/git/definitions.js';

/** Eight reusable slots bound retained source state across graph revisions. */
export class HuddleGitSources {
  constructor(
    private readonly db: HuddleStateDatabase,
    private readonly executions: HuddleExecutions,
    private readonly activations: HuddleActivations,
  ) {}
  current(slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= HUDDLE_GIT_LIMITS.sources)
      throw new Error('Invalid Git source slot');
    const row = this.db.get('git-sources', String(slot));
    return row ? huddleGitStateSchema.parse(JSON.parse(row.body)) : null;
  }
  initialise(
    definition: GitDefinition,
    activation: HuddleRevisionActivation,
    snapshot: HuddleGitSnapshot,
    commonDirectory: string,
  ) {
    return this.db.atomic(() => {
      const control = this.activations.current();
      if (control.state !== 'armed' || control.activationId !== activation.id)
        throw new Error('Huddle is not armed for Git admission');
      const existing = this.current(definition.slot);
      if (
        existing?.generation === control.generation &&
        existing.activationId === activation.id &&
        existing.node === definition.node
      ) {
        if (
          existing.worktree !== definition.worktree ||
          existing.repository !== definition.repository ||
          existing.commonDirectory !== commonDirectory
        )
          throw new Error('Git repository identity changed within its activation');
        return existing;
      }
      const state = huddleGitStateSchema.parse({
        node: definition.node,
        activationId: activation.id,
        generation: control.generation,
        worktree: definition.worktree,
        repository: definition.repository,
        commonDirectory,
        snapshot,
        sequence: 0,
        pending: null,
      });
      this.db.put('git-sources', String(definition.slot), activation.id, 'current', state, {
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
      throw new Error('Git activation changed');
    return state;
  }
  capture(slot: number, generation: number, snapshot: HuddleGitSnapshot, now: number) {
    const next = huddleGitSnapshotSchema.parse(snapshot);
    return this.db.atomic(() => {
      const state = this.active(slot, generation);
      if (state.pending) throw new Error('Admit the retained Git observation before replacing it');
      if (!gitChanges(state.snapshot, next).length) return false;
      state.pending = { snapshot: next, observedAt: new Date(now).toISOString(), batch: 0 };
      this.db.put('git-sources', String(slot), state.activationId, 'current', state, {
        bytes: 4096,
      });
      return true;
    });
  }
  admit(slot: number, generation: number, limits: HuddleDefinition['execution'], now: number) {
    return this.db.atomic(() => {
      const state = this.active(slot, generation);
      if (!state.pending) return null;
      const changes = gitChanges(state.snapshot, state.pending.snapshot);
      const offset = state.pending.batch * HUDDLE_GIT_LIMITS.changes;
      const batch = changes.slice(offset, offset + HUDDLE_GIT_LIMITS.changes),
        final = offset + batch.length === changes.length;
      if (!batch.length) throw new Error('Retained Git observation has no changes');
      const activation = this.activations.get(state.activationId),
        sequence = state.sequence + 1;
      const event = {
        format: 1 as const,
        id: `${activation.id}:${generation}:${sequence}`,
        source: { node: state.node, component: gitHuddleTrigger.id, version: 1 },
        port: 'event',
        observedAt: new Date(now).toISOString(),
        scope: this.db.identity,
        revision: activation.revision,
        executionId: randomUUID(),
        resource: { kind: 'worktree' as const, worktree: state.worktree },
        // No occurredAt: observed refs do not establish the exact time of a Git mutation.
        data: {
          changes: batch,
          repository: state.repository,
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
      this.db.put('git-sources', String(slot), activation.id, 'current', state, { bytes: 4096 });
      return accepted;
    });
  }
}
