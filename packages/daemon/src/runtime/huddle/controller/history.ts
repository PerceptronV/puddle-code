import { z } from 'zod';
import {
  huddleExecutionRecordSchema,
  huddleInvocationRecordSchema,
  huddleOperationRecordSchema,
  huddleRevisionSchema,
  type HuddleOwnerResponse,
} from '@puddle/shared';
import { HUDDLE_STATE_LIMITS } from '../state/database.js';

const after = z.number().int().nonnegative().safe();
export const huddleHistoryQuerySchema = z.discriminatedUnion('collection', [
  z.strictObject({
    collection: z.literal('executions'),
    after,
    parent: huddleRevisionSchema.optional(),
  }),
  z.strictObject({
    collection: z.literal('invocations'),
    after,
    parent: z.uuid(),
  }),
  z.strictObject({
    collection: z.literal('operations'),
    after,
    parent: z.uuid(),
  }),
]);
export type HuddleHistoryQuery = z.infer<typeof huddleHistoryQuerySchema>;
type Rows = Extract<HuddleOwnerResponse, { t: 'records' }>['rows'];

/** Ordinals page retained rows, not updates. Re-read a page to refresh mutable outcomes. */
export function readHuddleHistoryPage(query: HuddleHistoryQuery, rows: Rows) {
  if (
    rows.length > HUDDLE_STATE_LIMITS.page ||
    rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0) >
      HUDDLE_STATE_LIMITS.pageBytes
  )
    throw new Error('Huddle history page exceeds its limit');
  let previous = query.after;
  const ids = new Set<string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal <= previous || ids.has(row.id))
      throw new Error('Invalid huddle history ordering');
    previous = row.ordinal;
    ids.add(row.id);
  }
  const parse = <T extends { id: string }>(schema: { parse(value: unknown): T }) =>
    rows.map((row) => {
      const record = schema.parse(JSON.parse(row.body));
      if (record.id !== row.id) throw new Error('Huddle history record identity changed');
      return { ordinal: row.ordinal, record };
    });
  const next = rows.at(-1)?.ordinal ?? query.after;
  if (query.collection === 'executions') {
    const records = parse(huddleExecutionRecordSchema);
    if (query.parent && records.some(({ record }) => record.revision !== query.parent))
      throw new Error('Huddle history revision changed');
    return { collection: query.collection, records, next };
  }
  if (query.collection === 'invocations') {
    const records = parse(huddleInvocationRecordSchema);
    if (records.some(({ record }) => record.executionId !== query.parent))
      throw new Error('Huddle history execution changed');
    return { collection: query.collection, records, next };
  }
  const records = parse(huddleOperationRecordSchema);
  if (records.some(({ record }) => record.executionId !== query.parent))
    throw new Error('Huddle history execution changed');
  return { collection: query.collection, records, next };
}
