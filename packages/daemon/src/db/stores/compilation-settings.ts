import type { CompilationMode } from '@puddle/shared';
import type { Db } from '../db.js';

export interface CompilationSettingKey {
  profileId: string;
  projectId: string;
  provider: string;
  fileType: string;
  filePath: string;
  mode: CompilationMode;
}

/** SQLite persistence for explicit command overrides; provider defaults stay in code. */
export class CompilationSettingsStore {
  constructor(private readonly db: Db) {}

  get(key: CompilationSettingKey): string | null {
    const row = this.db
      .prepare(
        `SELECT command FROM compilation_settings
         WHERE profile_id = ? AND project_id = ? AND provider = ?
           AND file_type = ? AND file_path = ? AND mode = ?`,
      )
      .get(key.profileId, key.projectId, key.provider, key.fileType, key.filePath, key.mode) as
      { command: string } | undefined;
    return row?.command ?? null;
  }

  set(key: CompilationSettingKey, command: string | null): void {
    if (command === null) {
      this.db
        .prepare(
          `DELETE FROM compilation_settings
           WHERE profile_id = ? AND project_id = ? AND provider = ?
             AND file_type = ? AND file_path = ? AND mode = ?`,
        )
        .run(key.profileId, key.projectId, key.provider, key.fileType, key.filePath, key.mode);
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO compilation_settings
           (profile_id, project_id, provider, file_type, file_path, mode,
            command, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, project_id, provider, file_type, file_path, mode)
         DO UPDATE SET command = excluded.command, updated_at = excluded.updated_at`,
      )
      .run(
        key.profileId,
        key.projectId,
        key.provider,
        key.fileType,
        key.filePath,
        key.mode,
        command,
        now,
        now,
      );
  }
}
