import { uiStateSnapshotSchema, type UiStateResponse, type UiStateSnapshot } from '@puddle/shared';
import type { Db } from '../db.js';

interface Row {
  ui_state: string;
  updated_at: string;
}

/**
 * Per-profile workspace snapshots (SPEC §11 reload semantics): the centre
 * editor area is one surface shared across a profile's projects, so layout
 * follows identity alone — any browser, machine, or project restores the same
 * workspace once the profile is picked.
 */
export class ProfileStateStore {
  constructor(private readonly db: Db) {}

  /** The profile's snapshot, if it has one. */
  get(profileId: string): UiStateResponse | undefined {
    const row = this.db
      .prepare(`SELECT ui_state, updated_at FROM profile_states WHERE profile_id = ?`)
      .get(profileId) as Row | undefined;
    return row && this.parse(row);
  }

  put(profileId: string, uiState: UiStateSnapshot): UiStateResponse {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO profile_states (profile_id, ui_state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (profile_id) DO UPDATE SET ui_state = excluded.ui_state, updated_at = excluded.updated_at`,
      )
      .run(profileId, JSON.stringify(uiState), now);
    return { ui_state: uiState, updated_at: now };
  }

  /** Removes rows untouched for longer than the retention window. */
  gc(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`DELETE FROM profile_states WHERE updated_at < ?`).run(cutoff).changes;
  }

  private parse(row: Row): UiStateResponse {
    return {
      ui_state: uiStateSnapshotSchema.parse(JSON.parse(row.ui_state)),
      updated_at: row.updated_at,
    };
  }
}
