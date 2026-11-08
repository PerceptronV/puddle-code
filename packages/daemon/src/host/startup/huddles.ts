import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canAdoptHuddle, huddleIdSchema, huddleRuntimeCapabilitiesSchema } from '@puddle/shared';
import {
  readInstalledCapabilities,
  readInstalledDaemonRuntimeCapabilities,
} from '@puddle/shared/node/host-control';
import { requireOwnedDatabase } from '../../db/paths.js';
import { DATABASE_SCHEMA_VERSION } from '../../db/migrations/index.js';
import { readReleaseText } from '../releases/files.js';

/** Compatibility only. Starting a controller must remain possible for interrupted owners' recovery. */
export async function inspectStartupHuddles(home: string, release: string): Promise<void> {
  const file = join(home, 'puddle.db');
  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Fresh installation.
    throw error;
  }
  requireOwnedDatabase(file);
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.exec('BEGIN');
    const schema = db.pragma('user_version', { simple: true }) as number;
    if (!Number.isSafeInteger(schema) || schema < 0 || schema > DATABASE_SCHEMA_VERSION)
      throw new Error('Selected helper cannot inspect this application database');
    if (schema < 43) return; // Huddle roles do not exist in historical schemas.
    const rows = db
      .prepare(
        "SELECT substr(huddle_id, 1, 33) AS huddle_id, CASE WHEN typeof(huddle_capabilities) = 'text' AND length(CAST(huddle_capabilities AS BLOB)) <= 1024 THEN huddle_capabilities ELSE NULL END AS huddle_capabilities FROM runtime_bindings WHERE role = 'huddle' ORDER BY runtime_id LIMIT 4097",
      )
      .all() as Array<{ huddle_id: string; huddle_capabilities: string | null }>;
    if (rows.length > 4096) throw new Error('Startup huddle inventory exceeds its limit');
    if (!rows.length) return;
    const host = await readInstalledCapabilities(release);
    if (readReleaseText(join(release, 'VERSION'), 128).trim() !== host.version)
      throw new Error('Daemon capability version differs from the selected release');
    const roles = await readInstalledDaemonRuntimeCapabilities(release, host);
    if (host.database_schema_version === undefined || host.database_schema_version < schema)
      throw new Error('Selected daemon cannot open the retained huddle database');
    for (const row of rows) {
      huddleIdSchema.parse(row.huddle_id);
      const required = huddleRuntimeCapabilitiesSchema.parse(
        JSON.parse(row.huddle_capabilities ?? 'null'),
      );
      if (!canAdoptHuddle(roles, required))
        throw new Error('Selected daemon cannot adopt retained huddle contracts');
    }
  } finally {
    db.close();
  }
}
