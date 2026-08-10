import type { Account } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: string;
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
  /**
   * Notified when `setLoggedIn` actually changes the stored flag. The WS
   * gateway broadcasts it (protocol 15.1) so the accounts UI goes green the
   * moment a login verifies — the daemon only writes the flag AFTER the
   * adapter's own auth check answers, well after the login dialog has closed,
   * so without the push the badge sat stale until an unrelated refetch. One
   * consumer, wired once at boot; an EventEmitter would be ceremony for it.
   */
  onLoggedInChanged: ((account: Account) => void) | null = null;

  constructor(private readonly db: Db) {}

  create(input: {
    profile_id: string;
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

  list(profileId?: string): Account[] {
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
    // The WHERE clause makes change detection atomic: a no-op write (same
    // flag, or an account deleted meanwhile) notifies nobody.
    const flag = loggedIn ? 1 : 0;
    const info = this.db
      .prepare(`UPDATE accounts SET logged_in = ? WHERE id = ? AND logged_in != ?`)
      .run(flag, id, flag);
    if (info.changes > 0) this.onLoggedInChanged?.(this.get(id));
  }

  setSkipPermissionsDefault(id: number, skip: boolean): Account {
    this.get(id); // 404 before a silent no-op UPDATE
    this.db
      .prepare(`UPDATE accounts SET skip_permissions_default = ? WHERE id = ?`)
      .run(skip ? 1 : 0, id);
    return this.get(id);
  }

  /**
   * Rename the account's display label. Only the label moves — `config_dir`
   * stays put, so the agent keeps using the same on-disk config (and macOS
   * keychain OAuth, bound to that path, is untouched). The UNIQUE(profile_id,
   * agent_type, label) index makes a colliding rename a 409, not a silent clash.
   */
  setLabel(id: number, label: string): Account {
    this.get(id); // 404 before a silent no-op UPDATE
    try {
      this.db.prepare(`UPDATE accounts SET label = ? WHERE id = ?`).run(label, id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict(
          'account_exists',
          `an account named '${label}' already exists for this agent in this profile`,
        );
      }
      throw e;
    }
    return this.get(id);
  }
}
