import { randomUUID } from 'node:crypto';
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { REMOTE_POLICY, type DesktopRegistration } from '@puddle/shared';
import { digest, privateDirectory, privatePath, secret } from '@puddle/shared/node';

export interface HostRecord {
  id: string;
  account: string;
  label: string;
  credential: string | null;
}
export class ServiceStore {
  readonly db: Database.Database;
  constructor(home: string) {
    privateDirectory(home);
    const file = join(home, 'remote.db');
    if (existsSync(file)) privatePath(file);
    this.db = new Database(file);
    if (Number(this.db.pragma('user_version', { simple: true })) > 2) {
      this.db.close();
      throw new Error('Remote state requires a newer Puddle version');
    }
    chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_hosts(id TEXT PRIMARY KEY, account TEXT NOT NULL, label TEXT NOT NULL, credential TEXT);
      CREATE TABLE IF NOT EXISTS registrations(hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mfa_sessions(hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_registrations(hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires INTEGER NOT NULL, redeemed INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version = 2;
    `);
  }
  list(account: string): HostRecord[] {
    return this.db
      .prepare('SELECT * FROM remote_hosts WHERE account = ?')
      .all(account) as HostRecord[];
  }
  host(id: string): HostRecord | undefined {
    return this.db.prepare('SELECT * FROM remote_hosts WHERE id = ?').get(id) as
      HostRecord | undefined;
  }
  register(account: string, label: string) {
    this.prune();
    if (this.list(account).length >= 32) throw new Error('Host quota reached');
    const host = randomUUID();
    const code = secret();
    const expires = Date.now() + REMOTE_POLICY.invitationMs;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO remote_hosts VALUES (?, ?, ?, NULL)').run(host, account, label);
      this.db
        .prepare('INSERT INTO registrations VALUES (?, ?, ?)')
        .run(digest(code), host, expires);
    })();
    return { host, code, expires };
  }
  redeem(code: string) {
    return this.db.transaction(() => {
      const hash = digest(code);
      const desktop = this.db
        .prepare('SELECT host, expires, redeemed FROM desktop_registrations WHERE hash = ?')
        .get(hash) as { host: string; expires: number; redeemed: number } | undefined;
      const registration =
        desktop ??
        (this.db.prepare('SELECT host, expires FROM registrations WHERE hash = ?').get(hash) as
          { host: string; expires: number } | undefined);
      if (!registration || desktop?.redeemed || registration.expires <= Date.now())
        throw new Error('Registration code expired or used');
      const host = this.host(registration.host);
      if (!host) throw new Error('Registration host removed');
      const credential = secret();
      this.db
        .prepare('UPDATE remote_hosts SET credential = ? WHERE id = ?')
        .run(digest(credential), host.id);
      // Keep a tombstone until expiry: reopening a browser handoff cannot mint a second host.
      if (desktop)
        this.db.prepare('UPDATE desktop_registrations SET redeemed = 1 WHERE hash = ?').run(hash);
      else this.db.prepare('DELETE FROM registrations WHERE hash = ?').run(hash);
      return { host: host.id, account: host.account, credential };
    })();
  }
  registerDesktop(account: string, request: DesktopRegistration): void {
    const now = Date.now();
    if (request.expires <= now || request.expires > now + REMOTE_POLICY.invitationMs)
      throw new Error('Registration expired');
    this.prune();
    if (this.list(account).length >= 32) throw new Error('Host quota reached');
    this.db.transaction(() => {
      // A hash is a public request identifier, never a bearer credential. Reject duplicate
      // approvals across accounts and after redemption, including after host removal.
      if (this.db.prepare('SELECT 1 FROM registrations WHERE hash = ?').get(request.challenge))
        throw new Error('Registration already exists');
      const host = randomUUID();
      this.db
        .prepare('INSERT INTO remote_hosts VALUES (?, ?, ?, NULL)')
        .run(host, account, request.label);
      this.db
        .prepare('INSERT INTO desktop_registrations(hash, host, expires) VALUES (?, ?, ?)')
        .run(request.challenge, host, request.expires);
    })();
  }
  registrationReady(code: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM desktop_registrations r
      JOIN remote_hosts h ON h.id = r.host WHERE r.hash = ? AND r.expires > ? AND r.redeemed = 0`,
      )
      .get(digest(code), Date.now());
  }
  authenticate(credential: string): HostRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(credential)) return undefined;
    return this.db
      .prepare('SELECT * FROM remote_hosts WHERE credential = ?')
      .get(digest(credential)) as HostRecord | undefined;
  }
  remove(id: string, account: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM registrations WHERE host = ? AND host IN (SELECT id FROM remote_hosts WHERE account = ?)',
        )
        .run(id, account);
      this.db.prepare('DELETE FROM remote_hosts WHERE id = ? AND account = ?').run(id, account);
    })();
  }
  markMfa(token: string, account: string, expires: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO mfa_sessions VALUES (?, ?, ?)')
      .run(digest(token), account, expires);
  }
  hasMfa(token: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM mfa_sessions WHERE hash = ? AND expires > ?')
      .get(digest(token), Date.now());
  }
  clearMfa(account: string): void {
    this.db.prepare('DELETE FROM mfa_sessions WHERE account = ?').run(account);
  }
  prune(): void {
    this.db
      .prepare(
        `DELETE FROM remote_hosts WHERE credential IS NULL AND id IN
      (SELECT host FROM desktop_registrations WHERE expires <= ?)`,
      )
      .run(Date.now());
    this.db.prepare('DELETE FROM desktop_registrations WHERE expires <= ?').run(Date.now());
    this.db
      .prepare(
        'DELETE FROM remote_hosts WHERE credential IS NULL AND id IN (SELECT host FROM registrations WHERE expires <= ?)',
      )
      .run(Date.now());
    this.db.prepare('DELETE FROM registrations WHERE expires <= ?').run(Date.now());
    this.db.prepare('DELETE FROM mfa_sessions WHERE expires <= ?').run(Date.now());
  }
  close(): void {
    this.db.close();
  }
}
