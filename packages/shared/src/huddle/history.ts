import {
  huddleRetainedHistorySchema,
  type HuddleRetainedHistoryRequest,
} from '../api/huddle/history.js';

/** A recorded reply cannot silently substitute another owner, collection or page. */
export function parseHuddleRetainedHistory(input: HuddleRetainedHistoryRequest, value: unknown) {
  const result = huddleRetainedHistorySchema.parse(value);
  const page = result.history;
  if (
    page.owner.runtimeId !== input.owner.runtimeId ||
    page.owner.incarnation !== input.owner.incarnation ||
    page.collection !== input.collection
  )
    throw new Error('Retained history returned another owner or collection');
  let after = input.after;
  for (const { ordinal, record } of page.records) {
    if (ordinal <= after) throw new Error('Retained history returned invalid record ordering');
    after = ordinal;
    if (
      input.parent &&
      ('executionId' in record
        ? record.executionId !== input.parent
        : !('revision' in record) || record.revision !== input.parent)
    )
      throw new Error('Retained history returned another execution or revision');
  }
  if (page.next !== after) throw new Error('Retained history returned another page cursor');
  return result;
}
