import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  REMOTE_POLICY,
  connectorConfigSchema,
  profileId,
  remoteMaintenanceClaimSchema,
  type RemoteMaintenanceClaim,
} from '@puddle/shared';
import { privatePath, readPrivateJson } from '@puddle/shared/node';

/** Fresh, read-only authority from the host's registration, never the relay's assertion. */
export function remoteMaintenanceAuthority(
  home: string,
  profile: string,
  input: RemoteMaintenanceClaim,
  now = Date.now(),
): boolean {
  let db: Database.Database | undefined;
  try {
    const claim = remoteMaintenanceClaimSchema.parse(input);
    profileId.parse(profile);
    const remote = join(home, 'remote');
    const profiles = join(remote, 'profiles');
    const directory = join(profiles, profile);
    for (const path of [home, remote, profiles, directory]) privatePath(path, true);
    const config = connectorConfigSchema.parse(
      readPrivateJson(join(directory, 'config.json'), 32_768),
    );
    if (!config.enabled || config.account !== claim.account || config.host !== claim.host)
      return false;
    const file = join(directory, 'devices.db');
    privatePath(file);
    const before = lstatSync(file);
    if (!before.isFile()) return false;
    for (const suffix of ['-wal', '-shm']) {
      try {
        privatePath(file + suffix);
        if (!lstatSync(file + suffix).isFile()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // Reopen for every check: retaining a SQLite snapshot could conceal revocation.
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    if (db.pragma('user_version', { simple: true }) !== 4) return false;
    const row = db
      .prepare(
        `SELECT d.expires, d.lastUsed FROM devices d JOIN maintenance_grants g ON g.device = d.id
         WHERE d.id = ? AND d.peer = ? AND d.account = ? AND d.status = 'approved'
           AND g.host = ? AND g.grant = ?`,
      )
      .get(claim.device, claim.peer, claim.account, claim.host, claim.grant) as
      { expires: unknown; lastUsed: unknown } | undefined;
    const after = lstatSync(file);
    return (
      !!row &&
      typeof row.expires === 'number' &&
      Number.isFinite(row.expires) &&
      typeof row.lastUsed === 'number' &&
      Number.isFinite(row.lastUsed) &&
      row.expires > now &&
      row.lastUsed + REMOTE_POLICY.idleMs > now &&
      before.dev === after.dev &&
      before.ino === after.ino
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
