import type { RuntimePlacement } from '@puddle/shared';
import type { Db } from '../../db.js';
import { RuntimeObservationStore } from '../runtime-observations.js';
import type { ResultCapacityLimits } from './limits.js';

/** Caller identity insertion must commit in this same transaction before any provider dispatch. */
export function reserveRuntimeTurn(
  db: Db,
  runtimeId: string,
  placement: RuntimePlacement,
  observedTurn: number,
  limits?: ResultCapacityLimits,
): number {
  if (!db.inTransaction) throw new Error('Runtime turn admission requires a transaction');
  if (!Number.isSafeInteger(observedTurn) || observedTurn < 0)
    throw new Error('Invalid observed turn identity');
  const owner = db
    .prepare(
      `SELECT 1 FROM runtime_bindings WHERE runtime_id = ?
    AND active_session_id = ? AND active_segment_id = ? AND state = 'running' AND role = 'session'`,
    )
    .get(runtimeId, placement.session_id, placement.segment_id);
  if (!owner) throw new Error('Runtime placement changed before turn admission');
  const latest = db
    .prepare(
      `SELECT MAX(turn) AS turn FROM (
    SELECT turn FROM runtime_turn_watermarks WHERE runtime_id = ? UNION ALL
    SELECT turn FROM puddlang_runtime_turns WHERE runtime_id = ? UNION ALL
    SELECT turn FROM huddle_runtime_turns WHERE runtime_id = ?)`,
    )
    .get(runtimeId, runtimeId, runtimeId) as { turn: number | null };
  const turn = Math.max(latest.turn ?? 0, observedTurn) + 1;
  if (!Number.isSafeInteger(turn)) throw new Error('Runtime turn identities exhausted');
  new RuntimeObservationStore(db, limits).reserveTurnCapacity(runtimeId, turn);
  return turn;
}
