import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Db } from '../../../src/db/db.js';
import { MIGRATIONS } from '../../../src/db/migrations/index.js';

/** Seed an actual historical schema using its columns, not a downgraded user_version on today's tables. */
export function writeHistoricalDatabase(source: Db, file: string, version: number): void {
  if (existsSync(file)) throw new Error('Historical fixture destination already exists');
  const target = new Database(file);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    target.pragma('foreign_keys = OFF');
    for (const migration of MIGRATIONS.filter((m) => m.version <= version)) {
      target.exec(migration.sql);
      target.pragma(`user_version = ${migration.version}`);
    }
    const tables = target
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    target.pragma('foreign_keys = OFF');
    target.transaction(() => {
      for (const { name } of tables) {
        const columns = (
          target.pragma(`table_info(${quote(name)})`) as Array<{ name: string }>
        ).map((column) => column.name);
        const names = columns.map(quote).join(', ');
        const rows = source.prepare(`SELECT ${names} FROM ${quote(name)}`).all() as Array<
          Record<string, unknown>
        >;
        const insert = target.prepare(
          `INSERT OR REPLACE INTO ${quote(name)} (${names}) VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) insert.run(...columns.map((column) => row[column]));
      }
      if ((target.pragma('foreign_key_check') as unknown[]).length)
        throw new Error('Historical fixture has invalid references');
    })();
  } finally {
    target.close();
  }
}
