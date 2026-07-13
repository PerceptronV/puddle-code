import type { Db } from '../db.js';

export interface EventRow {
  id: number;
  session_id: string;
  type: string;
  payload: unknown;
  created_at: string;
}

/** Lifecycle audit trail (SPEC §3): created|resumed|interrupted|exited|killed|archived|… */
export class EventStore {
  constructor(private readonly db: Db) {}

  record(sessionId: string, type: string, payload?: unknown): void {
    this.db
      .prepare(`INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(
        sessionId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  list(sessionId: string): EventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<Omit<EventRow, 'payload'> & { payload: string | null }>;
    return rows.map((r) => ({ ...r, payload: r.payload === null ? null : JSON.parse(r.payload) }));
  }
}
