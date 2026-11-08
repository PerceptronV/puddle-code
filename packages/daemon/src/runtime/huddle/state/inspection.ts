import type Database from 'better-sqlite3';
import { huddleTriggerActivitySchema, HUDDLE_LIMITS } from '@puddle/shared';

/** Aggregate bounded retained records without loading event payloads into the controller/UI. */
export function triggerActivity(db: Database.Database, activationId: string | null) {
  const rows = db
    .prepare(
      `
    SELECT json_extract(i.body, '$.event.source.node') AS node,
      COUNT(*) AS admitted,
      SUM(e.state = 'pending') AS queued, SUM(e.state = 'running') AS running,
      MAX(json_extract(i.body, '$.event.observedAt')) AS last_event_at,
      SUM(CASE WHEN json_extract(i.body, '$.event.source.component') IN
        ('puddle.trigger.interval', 'puddle.trigger.calendar')
        THEN MAX(0, json_extract(i.body, '$.event.data.occurrences') - 1) ELSE 0 END) AS coalesced,
      SUM(CASE WHEN json_extract(i.body, '$.event.source.component') IN
        ('puddle.trigger.interval', 'puddle.trigger.calendar')
        THEN MAX(0, json_extract(i.body, '$.event.data.skipped')) ELSE 0 END) AS skipped
    FROM records e JOIN records i ON i.collection = 'inbox' AND i.id = json_extract(e.body, '$.eventKey')
    WHERE e.collection = 'executions' AND json_extract(e.body, '$.activationId') = ?
    GROUP BY node LIMIT ?
  `,
    )
    .all(activationId, HUDDLE_LIMITS.nodes + 1);
  if (rows.length > HUDDLE_LIMITS.nodes) throw new Error('Too many retained trigger sources');
  return rows.map((row) => huddleTriggerActivitySchema.parse(row));
}
