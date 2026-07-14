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

/**
 * Per-(project, profile) workspace snapshots (SPEC §11 reload semantics):
 * layout follows identity, so any browser or machine restores the same
 * workspace once the profile is picked.
 */
export class ProjectStateStore {
  constructor(private readonly db: Db) {}

  /** The profile's own snapshot for this project, if it has one. */
  get(projectId: string, profileId: string): ProjectStateResponse | undefined {
    const row = this.db
      .prepare(
        `SELECT ui_state, updated_at FROM project_states WHERE project_id = ? AND profile_id = ?`,
      )
      .get(projectId, profileId) as Row | undefined;
    return row && this.parse(row);
  }

  /** The project's most recent snapshot from any profile (seed for newcomers). */
  latest(projectId: string): ProjectStateResponse | undefined {
    const row = this.db
      .prepare(
        `SELECT ui_state, updated_at FROM project_states WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(projectId) as Row | undefined;
    return row && this.parse(row);
  }

  put(projectId: string, profileId: string, uiState: UiStateSnapshot): ProjectStateResponse {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_states (project_id, profile_id, ui_state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, profile_id) DO UPDATE SET ui_state = excluded.ui_state, updated_at = excluded.updated_at`,
      )
      .run(projectId, profileId, JSON.stringify(uiState), now);
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
