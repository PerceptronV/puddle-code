import {
  uiStateSnapshotSchema,
  type ProjectStateResponse,
  type UiStateSnapshot,
} from '@puddle/shared';
import type { Db } from '../db.js';

interface Row {
  ui_state: string;
  updated_at: string;
}

/** Per-(project, client) workspace snapshots (SPEC §11 reload semantics). */
export class ProjectStateStore {
  constructor(private readonly db: Db) {}

  /** The named client's own snapshot, if it has one. */
  get(projectId: number, clientId: string): ProjectStateResponse | undefined {
    const row = this.db
      .prepare(
        `SELECT ui_state, updated_at FROM project_states WHERE project_id = ? AND client_id = ?`,
      )
      .get(projectId, clientId) as Row | undefined;
    return row && this.parse(row);
  }

  /** The project's most recent snapshot from any client (seed for new clients). */
  latest(projectId: number): ProjectStateResponse | undefined {
    const row = this.db
      .prepare(
        `SELECT ui_state, updated_at FROM project_states WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(projectId) as Row | undefined;
    return row && this.parse(row);
  }

  put(projectId: number, clientId: string, uiState: UiStateSnapshot): ProjectStateResponse {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_states (project_id, client_id, ui_state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, client_id) DO UPDATE SET ui_state = excluded.ui_state, updated_at = excluded.updated_at`,
      )
      .run(projectId, clientId, JSON.stringify(uiState), now);
    return { ui_state: uiState, updated_at: now };
  }

  /** Removes rows untouched for longer than the retention window. */
  gc(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`DELETE FROM project_states WHERE updated_at < ?`).run(cutoff).changes;
  }

  private parse(row: Row): ProjectStateResponse {
    return {
      ui_state: uiStateSnapshotSchema.parse(JSON.parse(row.ui_state)),
      updated_at: row.updated_at,
    };
  }
}
