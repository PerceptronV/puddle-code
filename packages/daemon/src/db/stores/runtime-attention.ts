import { runtimeAttentionSchema, type RuntimeAttention } from '@puddle/shared';
import type { Db } from '../db.js';

export interface PendingRuntimeAttention {
  runtimeId: string;
  sessionId: string;
  attention: RuntimeAttention;
}

export class RuntimeAttentionStore {
  constructor(private readonly db: Db) {}

  observe(
    runtimeId: string,
    cursor: number,
    sessionId: string,
    attention: RuntimeAttention | null,
  ): void {
    const current = attention === null ? null : runtimeAttentionSchema.parse(attention);
    this.db
      .prepare(
        `INSERT INTO runtime_attention (runtime_id, cursor, session_id, event_id, attention)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET cursor = excluded.cursor, session_id = excluded.session_id,
      event_id = excluded.event_id, attention = excluded.attention
      WHERE excluded.cursor >= runtime_attention.cursor`,
      )
      .run(
        runtimeId,
        cursor,
        sessionId,
        current?.id ?? null,
        current ? JSON.stringify(current) : null,
      );
  }

  pending(after = ''): PendingRuntimeAttention[] {
    const rows = this.db
      .prepare(
        `SELECT runtime_id, session_id, attention FROM runtime_attention
      WHERE runtime_id > ? AND event_id IS NOT NULL AND (delivered_id IS NULL OR delivered_id != event_id)
      ORDER BY runtime_id LIMIT 32`,
      )
      .all(after) as Array<{ runtime_id: string; session_id: string; attention: string }>;
    return rows.map((row) => ({
      runtimeId: row.runtime_id,
      sessionId: row.session_id,
      attention: runtimeAttentionSchema.parse(JSON.parse(row.attention) as unknown),
    }));
  }

  /** Commit before emitting: a lost delivery is never automatically repeated. */
  claim(row: PendingRuntimeAttention): boolean {
    return (
      this.db
        .prepare(
          `UPDATE runtime_attention SET delivered_id = event_id
      WHERE runtime_id = ? AND session_id = ? AND event_id = ?
      AND (delivered_id IS NULL OR delivered_id != event_id)`,
        )
        .run(row.runtimeId, row.sessionId, row.attention.id).changes === 1
    );
  }
}
