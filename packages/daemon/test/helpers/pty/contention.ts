import { randomUUID } from 'node:crypto';
import { RuntimeHostAllowance } from '../../../src/runtime/resources/host/allowance.js';

/** Real cached admission with controllable durable CAS contention, without native SQLite. */
export function screenContention(capacity = 128 * 1024 * 1024) {
  let grant: { revision: number; bytes: number } | null = null;
  const ledger = {
    busy: 0,
    readGrant: () => grant,
    compareGrant: (_identity: unknown, revision: number, bytes: number) => {
      if (ledger.busy > 0) {
        ledger.busy--;
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      }
      if ((grant?.revision ?? 0) !== revision || bytes > capacity) return null;
      return (grant = { revision: revision + 1, bytes });
    },
  };
  const allowance = new RuntimeHostAllowance(
    ledger,
    { runtime_id: randomUUID(), incarnation: randomUUID(), launch_id: randomUUID() },
    4 * 1024 * 1024,
    0,
  );
  return { ledger, allowance };
}
