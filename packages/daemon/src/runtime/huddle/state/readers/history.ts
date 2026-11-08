import type { HuddleLedgerIdentity } from '@puddle/shared';
import { HUDDLE_STATE_LIMITS } from '../database.js';
import {
  huddleHistoryQuerySchema,
  readHuddleHistoryPage,
  type HuddleHistoryQuery,
} from '../../controller/history.js';
import { withHuddleReadSnapshot } from './database.js';

/** Recorded outcomes only: this does not inspect, start or reconcile an owner. */
export function readRetainedHuddleHistory(
  home: string,
  identity: HuddleLedgerIdentity,
  raw: HuddleHistoryQuery,
) {
  const query = huddleHistoryQuerySchema.parse(raw);
  return withHuddleReadSnapshot(home, identity, (db) => {
    const candidates = db
      .prepare(
        `SELECT ordinal,
      CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= 128 THEN id ELSE NULL END AS id,
      CASE WHEN typeof(body) = 'text' THEN length(CAST(body AS BLOB)) ELSE NULL END AS bytes
      FROM records WHERE collection = ? AND ordinal > ? AND (? IS NULL OR parent = ?)
      ORDER BY ordinal LIMIT ?`,
      )
      .all(
        query.collection,
        query.after,
        query.parent ?? null,
        query.parent ?? null,
        HUDDLE_STATE_LIMITS.page,
      ) as Array<{ ordinal: number; id: string | null; bytes: number | null }>;
    const rows: Array<{ ordinal: number; id: string; body: string }> = [];
    let bytes = 0;
    for (const row of candidates) {
      if (
        !row.id ||
        row.bytes === null ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > HUDDLE_STATE_LIMITS.pageBytes
      )
        throw new Error('Retained huddle history row exceeds its limit');
      if (bytes + row.bytes > HUDDLE_STATE_LIMITS.pageBytes) break;
      const value = db
        .prepare(
          `SELECT CASE WHEN typeof(body) = 'text' AND length(CAST(body AS BLOB)) <= ? THEN body ELSE NULL END AS body
        FROM records WHERE collection = ? AND ordinal = ? AND id = ?`,
        )
        .get(HUDDLE_STATE_LIMITS.pageBytes - bytes, query.collection, row.ordinal, row.id) as
        { body: string | null } | undefined;
      if (!value?.body)
        throw new Error('Retained huddle history row is missing or exceeds its limit');
      rows.push({ ordinal: row.ordinal, id: row.id, body: value.body });
      bytes += row.bytes;
    }
    return readHuddleHistoryPage(query, rows);
  });
}
