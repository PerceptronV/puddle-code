import type Database from 'better-sqlite3';

/** Read only unfinished work; retained terminal history never changes admission policy. */
export function triggerAdmissionWork(
  db: Database.Database,
  source: string,
  port: string,
  revision: string,
  activationId?: string,
) {
  const counts = db
    .prepare(
      `
    SELECT COUNT(*) AS busy, COALESCE(SUM(e.state = 'pending'), 0) AS pending
    FROM records i JOIN records e ON e.collection = 'executions'
      AND e.id = json_extract(i.body, '$.event.executionId')
    WHERE i.collection = 'inbox' AND i.parent = ? AND e.state IN ('pending', 'running')
  `,
    )
    .get(source) as { busy: number; pending: number };
  const latest = db
    .prepare(
      `
    SELECT e.id FROM records i JOIN records e ON e.collection = 'executions'
      AND e.id = json_extract(i.body, '$.event.executionId')
    WHERE i.collection = 'inbox' AND i.parent = ? AND e.state = 'pending'
      AND json_extract(i.body, '$.event.port') = ?
      AND json_extract(e.body, '$.revision') = ?
      AND json_extract(e.body, '$.activationId') IS ?
    ORDER BY e.ordinal DESC LIMIT 1
  `,
    )
    .get(source, port, revision, activationId ?? null) as { id: string } | undefined;
  return { ...counts, latest: latest?.id };
}
