import {
  canonicalHuddleJson,
  huddleExecutionRecordSchema,
  huddleInboxRecordSchema,
  huddleTriggerInputRequestSchema,
  type HuddleLedgerIdentity,
} from '@puddle/shared';
import { withHuddleReadSnapshot } from './database.js';
import { HUDDLE_STATE_LIMITS } from '../database.js';

/** Read the immutable root event and execution together, without contacting its owner. */
export function readHuddleTriggerInput(
  home: string,
  identity: HuddleLedgerIdentity,
  executionId: string,
  ancestors: readonly string[] = [],
) {
  huddleTriggerInputRequestSchema.shape.execution_id.parse(executionId);
  return withHuddleReadSnapshot(home, identity, (db) => {
    const read = (collection: string, id: string) => {
      const row = db
        .prepare(
          "SELECT CASE WHEN typeof(body) = 'text' AND length(CAST(body AS BLOB)) <= ? THEN body ELSE NULL END AS body FROM records WHERE collection = ? AND id = ?",
        )
        .get(HUDDLE_STATE_LIMITS.pageBytes, collection, id) as { body: string | null } | undefined;
      if (!row?.body) throw new Error('Recorded trigger input is missing or exceeds its limit');
      return JSON.parse(row.body) as unknown;
    };
    const execution = huddleExecutionRecordSchema.parse(read('executions', executionId));
    const { event } = huddleInboxRecordSchema.parse(read('inbox', execution.eventKey));
    // Recovery preserves old events; verified launch ancestry explains their runtime ids.
    if (
      execution.id !== executionId ||
      event.executionId !== executionId ||
      event.revision !== execution.revision ||
      ![identity.runtimeId, ...ancestors].includes(event.scope.runtimeId) ||
      canonicalHuddleJson({ ...event.scope, runtimeId: identity.runtimeId }) !==
        canonicalHuddleJson(identity)
    )
      throw new Error('Recorded trigger input differs from its execution or owner');
    return event;
  });
}
