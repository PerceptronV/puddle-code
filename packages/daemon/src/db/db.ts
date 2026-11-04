import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { DATABASE_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    const current = db.pragma('user_version', { simple: true }) as number;
    // Check before changing journal mode or running any application/migration write.
    // Selecting an older binary cannot undo database changes made by a newer one.
    if (!Number.isSafeInteger(current) || current < 0 || current > DATABASE_SCHEMA_VERSION)
      throw new Error(
        `Database schema ${current} is not supported by this daemon (maximum ${DATABASE_SCHEMA_VERSION}); use a compatible daemon without restoring older application data.`,
      );
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // Table rebuilds need FKs off for the duration (sqlite.org/lang_altertable,
    // "making other kinds of table schema changes"); a full foreign_key_check
    // before commit keeps the guarantee. The pragma cannot change inside a
    // transaction, hence the wrapping.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(`migration ${m.version} (${m.name}) breaks foreign keys`);
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}
