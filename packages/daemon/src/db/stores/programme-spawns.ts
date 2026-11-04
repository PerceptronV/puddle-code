import type { Db } from '../db.js';
import type { ProgrammeOperation } from '../../puddlang/runtime-turn-store.js';
import { ApiError } from '../../http/errors.js';

export interface ProgrammeSpawn {
  operation_id: number;
  session_id: string;
  runtime_id: string | null;
  stop_requested: number;
}

export class ProgrammeSpawnStore {
  constructor(private readonly db: Db) {}

  record(scope: ProgrammeOperation, sessionId: string): void {
    if (!Number.isSafeInteger(scope.operationId))
      throw new Error('Invalid programme operation identity');
    const allowed = this.db
      .prepare(
        `SELECT 1 FROM puddlang_runs r
      JOIN sessions s ON s.id = ? JOIN projects p ON p.id = s.project_id
      WHERE r.id = ? AND r.profile_id = ? AND p.profile_id = r.profile_id AND r.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM puddlang_stop_requests WHERE run_id = r.id)`,
      )
      .get(sessionId, scope.runId, scope.profileId);
    if (!allowed)
      throw new ApiError(403, 'profile_scope', 'This programme cannot create this runtime');
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM puddlang_runtime_spawns WHERE run_id = ?')
      .get(scope.runId) as { count: number };
    if (count.count >= 32) throw new Error('Programme spawn binding limit reached');
    this.db
      .prepare(
        'INSERT INTO puddlang_runtime_spawns (run_id, operation_id, session_id) VALUES (?, ?, ?)',
      )
      .run(scope.runId, scope.operationId, sessionId);
  }

  bind(scope: ProgrammeOperation, sessionId: string, runtimeId: string): void {
    const result = this.db
      .prepare(
        `UPDATE puddlang_runtime_spawns SET runtime_id = ?
      WHERE run_id = ? AND operation_id = ? AND session_id = ? AND runtime_id IS NULL AND stop_requested = 0
      AND EXISTS (SELECT 1 FROM puddlang_runs r JOIN runtime_bindings b ON b.runtime_id = ? AND b.profile_id = r.profile_id
        WHERE r.id = ? AND r.profile_id = ? AND r.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM puddlang_stop_requests WHERE run_id = r.id))`,
      )
      .run(
        runtimeId,
        scope.runId,
        scope.operationId,
        sessionId,
        runtimeId,
        scope.runId,
        scope.profileId,
      );
    if (result.changes !== 1)
      throw new Error('Programme spawn was cancelled or already dispatched');
  }

  list(profile: string, run: string): ProgrammeSpawn[] {
    return this.db
      .prepare(
        `SELECT s.operation_id, s.session_id, s.runtime_id,
      (s.stop_requested OR EXISTS (SELECT 1 FROM puddlang_stop_requests WHERE run_id = r.id)) AS stop_requested
      FROM puddlang_runtime_spawns s JOIN puddlang_runs r ON r.id = s.run_id
      WHERE r.id = ? AND r.profile_id = ?`,
      )
      .all(run, profile) as ProgrammeSpawn[];
  }

  requestStop(profile: string, run: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO puddlang_stop_requests (run_id)
      SELECT id FROM puddlang_runs WHERE id = ? AND profile_id = ?`,
      )
      .run(run, profile);
  }

  requestSpawnStop(profile: string, run: string, operation: number): void {
    this.db
      .prepare(
        `UPDATE puddlang_runtime_spawns SET stop_requested = 1
      WHERE run_id = ? AND operation_id = ? AND EXISTS (SELECT 1 FROM puddlang_runs WHERE id = ? AND profile_id = ?)`,
      )
      .run(run, operation, run, profile);
  }
}
