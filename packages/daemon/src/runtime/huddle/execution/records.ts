import type { HuddleCollection } from '../state/database.js';
import type { HuddleLedger } from '../state/ledger.js';

/** Preserve bounded database pages while callers process/transition records. */
export function* huddleRecords<T>(
  ledger: HuddleLedger,
  collection: HuddleCollection,
  schema: { parse(value: unknown): T },
  filter: { parent?: string; state?: string } = {},
): Generator<T> {
  let after = 0;
  for (;;) {
    const rows = ledger.page(collection, { ...filter, after });
    if (!rows.length) return;
    for (const row of rows) {
      after = row.ordinal;
      yield schema.parse(JSON.parse(row.body));
    }
  }
}
