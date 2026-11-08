import {
  HUDDLE_SESSION_FEED_LIMITS,
  huddleSessionFeedCursorSchema,
  huddleSessionFeedRecordSchema,
  huddleSessionFeedScopeSchema,
  type HuddleSessionFeedCursor,
  type HuddleSessionFeedRecord,
  type HuddleSessionFeedPage,
  type HuddleSessionFeedScope,
} from '@puddle/shared';
import type { Db } from '../../../db/db.js';

/** Private controller reads only. Callers must establish current project/profile authority. */
export class HuddleSessionFeed {
  constructor(private readonly db: Db) {}

  read(
    scope: HuddleSessionFeedScope,
    after: HuddleSessionFeedCursor | null,
  ): HuddleSessionFeedPage {
    const selected = huddleSessionFeedScopeSchema.parse(scope);
    const previous = after === null ? null : huddleSessionFeedCursorSchema.parse(after);
    return this.db.transaction((): HuddleSessionFeedPage => {
      const state = this.db
        .prepare('SELECT epoch, head, floor FROM huddle_session_feed_state WHERE singleton = 1')
        .get() as { epoch: string; head: number; floor: number } | undefined;
      if (
        !state ||
        !Number.isSafeInteger(state.floor) ||
        state.floor < 0 ||
        state.floor > state.head
      )
        throw new Error('Session feed checkpoint is unavailable');
      const cursor = huddleSessionFeedCursorSchema.parse({
        epoch: state.epoch,
        sequence: state.head,
      });
      if (!previous) return { state: 'baseline', cursor };
      const reason =
        previous.epoch !== state.epoch
          ? 'epoch'
          : previous.sequence < state.floor
            ? 'retention'
            : previous.sequence > state.head
              ? 'ahead'
              : null;
      if (reason) return { state: 'gap', cursor, floor: state.floor, reason };
      const placeholders = (values: string[]) => values.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT sequence, profile_id AS profileId, project_id AS projectId,
        session_id AS sessionId, worktree, session_kind AS sessionKind, event, source,
        previous_status AS previousStatus, status, observed_at AS observedAt
        FROM huddle_session_feed WHERE sequence > ? AND sequence <= ?
          AND profile_id = ? AND project_id = ? AND worktree = ?
          AND (? IS NULL OR session_id = ?) AND (? IS NULL OR session_id != ?)
          AND session_kind IN (${placeholders(selected.kinds)}) AND event IN (${placeholders(selected.events)})
        ORDER BY sequence LIMIT ?`,
        )
        .all(
          previous.sequence,
          state.head,
          selected.profileId,
          selected.projectId,
          selected.worktree,
          selected.sessionId ?? null,
          selected.sessionId ?? null,
          selected.excludeSessionId ?? null,
          selected.excludeSessionId ?? null,
          ...selected.kinds,
          ...selected.events,
          HUDDLE_SESSION_FEED_LIMITS.page,
        );
      const records: HuddleSessionFeedRecord[] = [];
      let bytes = 0;
      for (const row of rows) {
        const record = huddleSessionFeedRecordSchema.parse(row),
          size = Buffer.byteLength(JSON.stringify(record));
        // Leave room for envelope/checkpoint fields inside the private transport limit.
        if (bytes + size > HUDDLE_SESSION_FEED_LIMITS.pageBytes - 1024) break;
        records.push(record);
        bytes += size;
      }
      if (rows.length && !records.length)
        throw new Error('Session event cannot fit in a bounded page');
      return {
        state: 'events',
        head: state.head,
        records,
        cursor: {
          epoch: state.epoch,
          sequence:
            rows.length < HUDDLE_SESSION_FEED_LIMITS.page && records.length === rows.length
              ? state.head
              : records.at(-1)!.sequence,
        },
      };
    })();
  }
}
