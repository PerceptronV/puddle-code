import type { RuntimePlacement } from '@puddle/shared';
import type { Db } from '../db/db.js';
import { ApiError } from '../http/errors.js';
import { RuntimeObservationStore } from '../db/stores/runtime-observations.js';

export interface ProgrammeOperation {
  runId: string;
  operationId: number;
  profileId: string;
}

/** Only identities are stored here; replies stay in bounded private runtime observations. */
export class ProgrammeTurnStore {
  constructor(private readonly db: Db) {}

  check(scope: ProgrammeOperation, runtimeId: string): void {
    const row = this.db
      .prepare(
        `SELECT 1 FROM puddlang_runs p
      JOIN runtime_bindings r ON r.runtime_id = ?
      WHERE p.id = ? AND p.profile_id = ? AND r.profile_id = p.profile_id
      AND p.status = 'running'`,
      )
      .get(runtimeId, scope.runId, scope.profileId);
    if (!row) throw new ApiError(403, 'profile_scope', 'This programme cannot control the runtime');
  }

  /** Marks a committed outcome read by this caller, not delivered to its runner. */
  consume(scope: ProgrammeOperation, runtimeId: string, turn: number) {
    return this.db.transaction(() => {
      this.check(scope, runtimeId);
      const mapping = this.db
        .prepare(
          `SELECT 1 FROM puddlang_runtime_turns
        WHERE run_id = ? AND operation_id = ? AND runtime_id = ? AND turn = ?`,
        )
        .get(scope.runId, scope.operationId, runtimeId, turn);
      if (!mapping) throw new Error('Programme turn binding does not match');
      const result = new RuntimeObservationStore(this.db).turn(runtimeId, turn);
      if (!result || result.status === 'running') return result;
      this.db
        .prepare('UPDATE runtime_turns SET consumed = 1 WHERE runtime_id = ? AND turn = ?')
        .run(runtimeId, turn);
      return result;
    })();
  }

  reserve(
    scope: ProgrammeOperation,
    runtimeId: string,
    placement: RuntimePlacement,
    expectedRef: string | null,
    observedTurn: number,
  ): number {
    if (
      !Number.isSafeInteger(scope.operationId) ||
      !Number.isSafeInteger(observedTurn) ||
      observedTurn < 0
    )
      throw new Error('Invalid programme operation identity');
    return this.db.transaction(() => {
      this.check(scope, runtimeId);
      if (
        this.db
          .prepare('SELECT 1 FROM puddlang_runtime_turns WHERE run_id = ? AND operation_id = ?')
          .get(scope.runId, scope.operationId)
      )
        throw ApiError.conflict(
          'operation_already_dispatched',
          'This operation already has a turn identity; inspect its outcome without resubmitting',
        );
      const count = this.db
        .prepare('SELECT COUNT(*) AS count FROM puddlang_runtime_turns WHERE run_id = ?')
        .get(scope.runId) as { count: number };
      if (count.count >= 1000) throw new Error('Programme turn binding limit reached');
      const owner = this.db
        .prepare(
          `SELECT 1 FROM runtime_bindings WHERE runtime_id = ?
        AND active_session_id = ? AND active_segment_id = ? AND state = 'running'`,
        )
        .get(runtimeId, placement.session_id, placement.segment_id);
      if (!owner) throw new Error('Runtime placement changed before turn admission');
      new RuntimeObservationStore(this.db).reserveTurnCapacity(runtimeId);
      const latest = this.db
        .prepare(
          `SELECT MAX(turn) AS turn FROM (
        SELECT turn FROM runtime_turn_watermarks WHERE runtime_id = ? UNION ALL
        SELECT turn FROM puddlang_runtime_turns WHERE runtime_id = ?)`,
        )
        .get(runtimeId, runtimeId) as { turn: number | null };
      const turn = Math.max(latest.turn ?? 0, observedTurn) + 1;
      if (!Number.isSafeInteger(turn)) throw new Error('Runtime turn identities exhausted');
      this.db
        .prepare(
          `INSERT INTO puddlang_runtime_turns
        (run_id, operation_id, runtime_id, turn, session_id, segment_id, expected_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.runId,
          scope.operationId,
          runtimeId,
          turn,
          placement.session_id,
          placement.segment_id,
          expectedRef,
        );
      return turn;
    })();
  }
}
