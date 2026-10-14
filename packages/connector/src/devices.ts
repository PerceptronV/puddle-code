import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  REMOTE_POLICY,
  remoteDeviceSchema,
  notificationPreviewKeySchema,
  type NotificationPreviewKey,
  type RemoteDevice,
} from '@puddle/shared';
import { digest, privateDirectory, privatePath, secret } from '@puddle/shared/node';

/** Host-owned records only. Relay account recovery cannot write this database. */
export class DeviceStore {
  private readonly db: Database.Database;
  private readonly listeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  constructor(
    directory: string,
    private readonly now = Date.now,
  ) {
    privateDirectory(directory);
    const file = join(directory, 'devices.db');
    if (existsSync(file)) privatePath(file);
    this.db = new Database(file);
    if (Number(this.db.pragma('user_version', { simple: true })) > 3) {
      this.db.close();
      throw new Error('Remote state requires a newer Puddle version');
    }
    chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL, account TEXT NOT NULL, label TEXT NOT NULL,
        created INTEGER NOT NULL, lastUsed INTEGER NOT NULL, expires INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','revoked'))
      );
      CREATE TABLE IF NOT EXISTS invitations (
        hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, device TEXT REFERENCES devices(id)
      );
      CREATE TABLE IF NOT EXISTS notification_devices(device TEXT PRIMARY KEY REFERENCES devices(id));
      CREATE TABLE IF NOT EXISTS notification_keys(device TEXT PRIMARY KEY REFERENCES devices(id), value TEXT NOT NULL);
      PRAGMA user_version = 3;
    `);
  }
  invite(): { invitation: string; expires: number } {
    this.db.prepare('DELETE FROM invitations WHERE expires <= ?').run(this.now());
    const count = this.db.prepare('SELECT count(*) AS n FROM invitations').get() as { n: number };
    if (count.n >= 8) throw new Error('Too many pending invitations; wait for expiry');
    const invitation = secret();
    const expires = this.now() + REMOTE_POLICY.invitationMs;
    this.db
      .prepare('INSERT INTO invitations(hash, expires) VALUES (?, ?)')
      .run(digest(invitation), expires);
    return { invitation, expires };
  }
  enrol(invitation: string, peer: string, account: string, label: string): RemoteDevice {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT expires, device FROM invitations WHERE hash = ?')
        .get(digest(invitation)) as { expires: number; device: string | null } | undefined;
      if (!row || row.expires <= this.now() || row.device)
        throw new Error('Invitation has expired or was used');
      const device: RemoteDevice = {
        id: randomUUID(),
        peer,
        account,
        label,
        created: this.now(),
        lastUsed: this.now(),
        expires: row.expires,
        status: 'pending',
      };
      this.db
        .prepare(
          'INSERT INTO devices VALUES (@id,@peer,@account,@label,@created,@lastUsed,@expires,@status)',
        )
        .run(device);
      this.db
        .prepare('UPDATE invitations SET device = ? WHERE hash = ? AND device IS NULL')
        .run(device.id, digest(invitation));
      return device;
    })();
  }
  list(): RemoteDevice[] {
    return this.db
      .prepare('SELECT * FROM devices ORDER BY created DESC')
      .all()
      .map((row) => remoteDeviceSchema.parse(row));
  }
  find(peer: string, account: string): RemoteDevice | undefined {
    return this.list().find(
      (device) =>
        device.peer === peer && device.account === account && this.valid(device.id, peer, account),
    );
  }
  pending(peer: string, account: string): RemoteDevice | undefined {
    return this.list().find(
      (device) =>
        device.peer === peer &&
        device.account === account &&
        device.status === 'pending' &&
        device.expires > this.now(),
    );
  }
  valid(id: string, peer: string, account: string): boolean {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!row) return false;
    const device = remoteDeviceSchema.parse(row);
    return (
      device.status === 'approved' &&
      device.peer === peer &&
      device.account === account &&
      device.expires > this.now() &&
      device.lastUsed + REMOTE_POLICY.idleMs > this.now()
    );
  }
  setNotifications(id: string, enabled: boolean, key?: NotificationPreviewKey): void {
    this.db.prepare('DELETE FROM notification_keys WHERE device = ?').run(id);
    if (enabled && key)
      this.db
        .prepare('INSERT INTO notification_keys VALUES (?, ?)')
        .run(id, JSON.stringify(notificationPreviewKeySchema.parse(key)));
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO notification_devices VALUES (?)').run(id);
    else this.db.prepare('DELETE FROM notification_devices WHERE device = ?').run(id);
  }
  notificationKey(id: string): NotificationPreviewKey | undefined {
    const row = this.db.prepare('SELECT value FROM notification_keys WHERE device = ?').get(id) as
      { value: string } | undefined;
    return row ? notificationPreviewKeySchema.parse(JSON.parse(row.value)) : undefined;
  }
  notificationDevices(): string[] {
    return (
      this.db
        .prepare(
          "SELECT n.device FROM notification_devices n JOIN devices d ON d.id = n.device WHERE d.status = 'approved' AND d.expires > ? AND d.lastUsed > ? LIMIT 64",
        )
        .all(this.now(), this.now() - REMOTE_POLICY.idleMs) as { device: string }[]
    ).map((row) => row.device);
  }
  touch(id: string): void {
    this.db
      .prepare('UPDATE devices SET lastUsed = ? WHERE id = ? AND lastUsed < ?')
      .run(this.now(), id, this.now() - 60_000);
  }
  approve(id: string): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM devices WHERE id = ? AND status = 'pending'")
        .get(id);
      const device = remoteDeviceSchema.safeParse(row);
      if (!device.success || device.data.expires <= this.now())
        throw new Error('Pairing request has expired');
      this.db
        .prepare(
          "UPDATE devices SET status = 'revoked' WHERE peer = ? AND account = ? AND status = 'approved'",
        )
        .run(device.data.peer, device.data.account);
      this.db
        .prepare(
          "UPDATE devices SET status = 'approved', created = ?, lastUsed = ?, expires = ? WHERE id = ?",
        )
        .run(this.now(), this.now(), this.now() + REMOTE_POLICY.absoluteMs, id);
      this.db.prepare('DELETE FROM invitations WHERE device = ?').run(id);
    })();
    for (const listener of this.listeners) listener();
  }
  revoke(id: string): void {
    this.setNotifications(id, false);
    this.db.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(id);
    for (const listener of this.listeners) listener();
  }
  revokeAll(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM notification_keys').run();
      this.db.prepare('DELETE FROM notification_devices').run();
      this.db.prepare("UPDATE devices SET status = 'revoked'").run();
      this.db.prepare('DELETE FROM invitations').run();
    })();
    for (const listener of this.listeners) listener();
  }
  close(): void {
    this.db.close();
  }
}
