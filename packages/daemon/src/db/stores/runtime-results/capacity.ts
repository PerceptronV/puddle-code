import type { Db } from '../../db.js';
import {
  RESULT_CAPACITY_LIMITS,
  RESULT_RESERVATION_BYTES,
  type ResultCapacityLimits,
} from './limits.js';

interface Usage {
  turns: number;
  bytes: number;
}
const eligible =
  "consumed = 1 AND json_extract(result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')";
/** Each admission touches at most one owner window and one host window. */
export const RESULT_RECLAIM_CANDIDATES = 256;

/** Call only inside the observation/admission transaction; SQLite serialises competing writers. */
export class RuntimeResultCapacity {
  constructor(
    private readonly db: Db,
    private readonly limits: ResultCapacityLimits = RESULT_CAPACITY_LIMITS,
  ) {
    for (const scope of [limits.runtime, limits.host])
      if (![scope.bytes, scope.turns].every((n) => Number.isSafeInteger(n) && n > 0))
        throw new Error('Invalid runtime result capacity');
  }

  makeRoom(id: string, turn: number, bytes: number): void {
    this.requireOpen(id);
    const previous = this.db
      .prepare('SELECT bytes FROM runtime_result_charges WHERE runtime_id = ? AND turn = ?')
      .get(id, turn) as { bytes: number } | undefined;
    // An existing reservation remains usable even when a conservative migration
    // found more historical debt than today's admission budget allows.
    if (previous && bytes <= previous.bytes) return;
    const extra = { turns: previous ? 0 : 1, bytes: bytes - (previous?.bytes ?? 0) };
    const fits = (scope: 'runtime' | 'host') => {
      const usage = (
        scope === 'runtime'
          ? this.db
              .prepare('SELECT turns, bytes FROM runtime_result_usage WHERE runtime_id = ?')
              .get(id)
          : this.db.prepare('SELECT turns, bytes FROM host_result_usage WHERE singleton = 1').get()
      ) as Usage | undefined;
      const limit = this.limits[scope];
      return (
        (usage?.turns ?? 0) + extra.turns <= limit.turns &&
        (usage?.bytes ?? 0) + extra.bytes <= limit.bytes
      );
    };
    const remove = this.db.prepare('DELETE FROM runtime_turns WHERE runtime_id = ? AND turn = ?');
    for (const scope of ['runtime', 'host'] as const) {
      if (fits(scope)) continue;
      // Keep the existing owner's oldest-consumed policy. Across owners, prefer
      // larger disposable replies so one bounded pass can recover useful space.
      const rows = (
        scope === 'runtime'
          ? this.db
              .prepare(
                `SELECT runtime_id, turn FROM runtime_turns INDEXED BY runtime_result_reclaim_owner
              WHERE ${eligible} AND runtime_id = ? AND turn != ? ORDER BY turn LIMIT ?`,
              )
              .all(id, turn, RESULT_RECLAIM_CANDIDATES)
          : this.db
              .prepare(
                `SELECT runtime_id, turn FROM runtime_turns INDEXED BY runtime_result_reclaim_host
              WHERE ${eligible} AND NOT (runtime_id = ? AND turn = ?)
              ORDER BY bytes DESC, runtime_id, turn LIMIT ?`,
              )
              .all(id, turn, RESULT_RECLAIM_CANDIDATES)
      ) as Array<{ runtime_id: string; turn: number }>;
      for (const row of rows) {
        if (fits(scope)) break;
        remove.run(row.runtime_id, row.turn);
      }
      if (!fits(scope)) throw new Error('Private runtime result retention is full');
    }
  }

  requireOpen(id: string): void {
    if (
      this.db
        .prepare('SELECT 1 FROM runtime_result_usage WHERE runtime_id = ? AND retired = 1')
        .get(id)
    )
      throw new Error('Runtime result admission has retired');
  }

  reserve(id: string, turn: number, bytes: number): void {
    this.makeRoom(id, turn, bytes);
    this.db
      .prepare(
        `INSERT INTO runtime_result_charges VALUES (?, ?, ?)
      ON CONFLICT(runtime_id, turn) DO UPDATE SET bytes = MAX(bytes, excluded.bytes)`,
      )
      .run(id, turn, bytes);
  }

  /** The caller has advanced the immutable watermark in this same transaction. */
  retireUncreatable(id: string, turn: number): void {
    const rows = this.db
      .prepare(
        `SELECT c.turn FROM runtime_result_charges c
      WHERE c.runtime_id = ? AND c.turn <= ?
      AND NOT EXISTS (SELECT 1 FROM runtime_turns t WHERE t.runtime_id = c.runtime_id AND t.turn = c.turn)
      ORDER BY c.turn LIMIT ?`,
      )
      .all(id, turn, RESULT_RECLAIM_CANDIDATES) as Array<{ turn: number }>;
    const remove = this.db.prepare(
      'DELETE FROM runtime_result_charges WHERE runtime_id = ? AND turn = ?',
    );
    for (const row of rows) remove.run(id, row.turn);
  }

  /** Only the final-journal commit under launch/owner retirement claims may publish this proof. */
  retire(id: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime_result_usage(runtime_id, turns, bytes, retired, pending_cleanup) VALUES (?, 0, 0, 1, 1)
      ON CONFLICT(runtime_id) DO UPDATE SET retired = 1, pending_cleanup = 1`,
      )
      .run(id);
    this.pruneRetired(id);
  }

  private pruneRetired(id: string): void {
    this.retireUncreatable(id, Number.MAX_SAFE_INTEGER);
    if (
      !this.db
        .prepare(
          `SELECT 1 FROM runtime_result_charges c WHERE c.runtime_id = ?
      AND NOT EXISTS (SELECT 1 FROM runtime_turns t WHERE t.runtime_id = c.runtime_id AND t.turn = c.turn) LIMIT 1`,
        )
        .get(id)
    )
      this.db
        .prepare('UPDATE runtime_result_usage SET pending_cleanup = 0 WHERE runtime_id = ?')
        .run(id);
  }

  /** Bounded, separately committed upkeep makes progress even when new admission cannot fit. */
  maintain(): boolean {
    return this.db.transaction(() => {
      // A complete final journal and the durable owner fence make these absent
      // slots impossible. This proof never applies to unavailable/lost owners.
      const retired = this.db
        .prepare(
          `SELECT runtime_id FROM runtime_result_usage INDEXED BY runtime_result_retired
        WHERE pending_cleanup = 1 ORDER BY runtime_id LIMIT 1`,
        )
        .get() as { runtime_id: string } | undefined;
      if (retired) this.pruneRetired(retired.runtime_id);
      const pressured = () => {
        const current = this.db
          .prepare('SELECT turns, bytes FROM host_result_usage WHERE singleton = 1')
          .get() as Usage;
        return (
          current.turns >= this.limits.host.turns ||
          current.bytes > this.limits.host.bytes - RESULT_RESERVATION_BYTES
        );
      };
      if (pressured()) {
        const rows = this.db
          .prepare(
            `SELECT runtime_id, turn FROM runtime_turns INDEXED BY runtime_result_reclaim_host
          WHERE ${eligible} ORDER BY bytes DESC, runtime_id, turn LIMIT ?`,
          )
          .all(RESULT_RECLAIM_CANDIDATES) as Array<{ runtime_id: string; turn: number }>;
        const remove = this.db.prepare(
          'DELETE FROM runtime_turns WHERE runtime_id = ? AND turn = ?',
        );
        for (const row of rows) {
          if (!pressured()) break;
          remove.run(row.runtime_id, row.turn);
        }
      }
      return (
        !!this.db
          .prepare(
            'SELECT 1 FROM runtime_result_usage INDEXED BY runtime_result_retired WHERE pending_cleanup = 1 LIMIT 1',
          )
          .get() ||
        (pressured() &&
          !!this.db
            .prepare(
              `SELECT 1 FROM runtime_turns INDEXED BY runtime_result_reclaim_host WHERE ${eligible} LIMIT 1`,
            )
            .get())
      );
    })();
  }
}
