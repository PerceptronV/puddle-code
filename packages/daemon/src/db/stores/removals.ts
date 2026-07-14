import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

/**
 * Guarded cascade deletion for profiles and accounts (SPEC §6/§11 "remove").
 * Anything still resumable blocks deletion; archived session rows (plus their
 * events) go with the thing that owned them. Returns the directories the
 * caller must remove from disk — the store never touches the filesystem.
 */
export class RemovalStore {
  constructor(private readonly db: Db) {}

  /** 409 unless every session on the account is archived. */
  deleteAccount(accountId: number): { config_dir: string } {
    const account = this.db
      .prepare(`SELECT id, config_dir FROM accounts WHERE id = ?`)
      .get(accountId) as { id: number; config_dir: string } | undefined;
    if (!account) throw ApiError.notFound('account', accountId);

    const live = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND status != 'archived'`)
      .get(accountId) as { n: number };
    if (live.n > 0) {
      throw ApiError.conflict(
        'account_in_use',
        `account has ${live.n} non-archived session(s) — archive them first`,
      );
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ?)`,
        )
        .run(accountId);
      this.db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(accountId);
      this.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    })();
    return { config_dir: account.config_dir };
  }

  /** 409 unless every session in every project of the profile is archived. */
  deleteProfile(profileId: string): { config_dirs: string[] } {
    const profile = this.db.prepare(`SELECT id FROM profiles WHERE id = ?`).get(profileId) as
      { id: string } | undefined;
    if (!profile) throw ApiError.notFound('profile', profileId);

    const live = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE status != 'archived'
           AND (project_id IN (SELECT id FROM projects WHERE profile_id = ?)
                OR account_id IN (SELECT id FROM accounts WHERE profile_id = ?))`,
      )
      .get(profileId, profileId) as { n: number };
    if (live.n > 0) {
      throw ApiError.conflict(
        'profile_in_use',
        `profile has ${live.n} non-archived session(s) — archive them first`,
      );
    }

    const configDirs = (
      this.db
        .prepare(`SELECT config_dir FROM accounts WHERE profile_id = ?`)
        .all(profileId) as Array<{ config_dir: string }>
    ).map((row) => row.config_dir);

    this.db.transaction(() => {
      const sessionFilter = `project_id IN (SELECT id FROM projects WHERE profile_id = ?)
                             OR account_id IN (SELECT id FROM accounts WHERE profile_id = ?)`;
      this.db
        .prepare(
          `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ${sessionFilter})`,
        )
        .run(profileId, profileId);
      this.db.prepare(`DELETE FROM sessions WHERE ${sessionFilter}`).run(profileId, profileId);
      // Both the layouts on its own projects and the layouts this profile
      // wrote while viewing other profiles' projects.
      this.db
        .prepare(
          `DELETE FROM project_states WHERE profile_id = ?
             OR project_id IN (SELECT id FROM projects WHERE profile_id = ?)`,
        )
        .run(profileId, profileId);
      this.db.prepare(`DELETE FROM prompts WHERE profile_id = ?`).run(profileId);
      this.db.prepare(`DELETE FROM projects WHERE profile_id = ?`).run(profileId);
      this.db.prepare(`DELETE FROM accounts WHERE profile_id = ?`).run(profileId);
      this.db.prepare(`DELETE FROM profiles WHERE id = ?`).run(profileId);
    })();
    return { config_dirs: configDirs };
  }
}
