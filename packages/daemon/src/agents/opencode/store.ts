import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpenCodeSession {
  id: string;
  directory: string;
  title: string | null;
  parentID: string | null;
  parentRef?: string | null;
  createdAt: number | null;
  updatedAt: number;
}

/** Read metadata only; native writers must never impose a SQLite busy wait. */
export async function openCodeDatabaseSessions(
  configDir: string,
  filter: { ref?: string; directory?: string } = {},
): Promise<OpenCodeSession[] | null> {
  const file = join(configDir, 'data', 'opencode', 'opencode.db');
  try {
    await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(file, {
      readonly: true,
      fileMustExist: true,
      timeout: 0,
    });
    const tables = new Set(
      (
        db.prepare("select name from sqlite_schema where type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    const table = tables.has('session_v2')
      ? 'session_v2'
      : tables.has('session')
        ? 'session'
        : null;
    if (!table) return null; // Older releases retain JSON files instead.
    const columns = new Set(
      (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    if (
      !['id', 'directory', 'title', 'parent_id', 'time_created', 'time_updated'].every((name) =>
        columns.has(name),
      )
    )
      throw new Error('OpenCode native catalogue schema is unavailable');
    if (table === 'session_v2' && !columns.has('fork_session_id'))
      throw new Error('OpenCode native fork metadata is unavailable');
    const statement = db.prepare(`select id, directory, substr(title, 1, 80) as title,
      parent_id as parentID, ${table === 'session_v2' ? 'fork_session_id' : 'null'} as parentRef,
      time_created as createdAt, time_updated as updatedAt from ${table}
      where id > ? ${filter.ref ? 'and id = ?' : ''}
      ${filter.directory ? 'and directory = ?' : ''} order by id limit 256`);
    const found: OpenCodeSession[] = [];
    let after = '';
    for (;;) {
      const rows = statement.all(
        after,
        ...(filter.ref ? [filter.ref] : []),
        ...(filter.directory ? [filter.directory] : []),
      ) as OpenCodeSession[];
      for (const row of rows) {
        if (
          typeof row.id !== 'string' ||
          typeof row.directory !== 'string' ||
          !Number.isFinite(row.createdAt) ||
          !Number.isFinite(row.updatedAt)
        )
          throw new Error('OpenCode native catalogue contains invalid metadata');
        found.push(row);
      }
      if (rows.length < 256) return found;
      after = rows.at(-1)!.id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    // Errors propagate: an incomplete scan must never confirm native deletion.
    db?.close();
  }
}
