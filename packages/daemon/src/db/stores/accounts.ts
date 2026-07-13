import type { Account } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: number;
  agent_type: string;
  label: string;
  config_dir: string;
  skip_permissions_default: number;
  logged_in: number;
  created_at: string;
}

function toAccount(r: Row): Account {
  return {
    id: r.id,
    profile_id: r.profile_id,
    agent_type: r.agent_type,
    label: r.label,
    config_dir: r.config_dir,
    skip_permissions_default: r.skip_permissions_default === 1,
    logged_in: r.logged_in === 1,
    created_at: r.created_at,
  };
}

export class AccountStore {
  constructor(private readonly db: Db) {}

  create(input: {
    profile_id: number;
    agent_type: string;
    label: string;
    config_dir: string;
    skip_permissions_default: boolean;
  }): Account {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO accounts (profile_id, agent_type, label, config_dir, skip_permissions_default, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.profile_id,
          input.agent_type,
          input.label,
          input.config_dir,
          input.skip_permissions_default ? 1 : 0,
          new Date().toISOString(),
        );
      return this.get(Number(info.lastInsertRowid));
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict(
          'account_exists',
          `account '${input.label}' for ${input.agent_type} already exists in this profile`,
        );
      }
      throw e;
    }
  }

  list(profileId?: number): Account[] {
    const rows = (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM accounts ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM accounts WHERE profile_id = ? ORDER BY id`).all(profileId)
    ) as Row[];
    return rows.map(toAccount);
  }

  get(id: number): Account {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('account', id);
    return toAccount(row);
  }

  setLoggedIn(id: number, loggedIn: boolean): void {
    this.db.prepare(`UPDATE accounts SET logged_in = ? WHERE id = ?`).run(loggedIn ? 1 : 0, id);
  }
}
