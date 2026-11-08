import type { Db } from '../db.js';
import type { RuntimeBinding } from './runtimes.js';

/** Only final reconciled owners are eligible; an unreachable live binding is protected. */
export class RuntimeServiceCleanupStore {
  constructor(private readonly db: Db) {}

  pending(after = ''): RuntimeBinding[] {
    return this.db
      .prepare(
        `
      SELECT r.* FROM runtime_service_cleanup c
      JOIN runtime_bindings r ON r.runtime_id = c.runtime_id
      WHERE c.completed_at IS NULL AND c.runtime_id > ?
        AND r.state IN ('exited', 'failed', 'interrupted')
        AND (r.role != 'huddle' OR r.state = 'exited')
      ORDER BY c.runtime_id LIMIT 32
    `,
      )
      .all(after) as RuntimeBinding[];
  }

  complete(runtimeId: string): void {
    this.db
      .prepare(
        `
      UPDATE runtime_service_cleanup SET completed_at = ?
      WHERE runtime_id = ? AND completed_at IS NULL AND EXISTS (
        SELECT 1 FROM runtime_bindings r WHERE r.runtime_id = runtime_service_cleanup.runtime_id
          AND r.state IN ('exited', 'failed', 'interrupted')
          AND (r.role != 'huddle' OR r.state = 'exited')
      )
    `,
      )
      .run(new Date().toISOString(), runtimeId);
  }
}
