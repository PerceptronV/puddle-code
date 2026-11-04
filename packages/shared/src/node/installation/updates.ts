import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_UPDATE_RECORD_BYTES,
  hostUpdateLedgerSchema,
  type HostUpdateLedger,
} from '../../installation/update.js';
import { digest, initialisePrivateHome, privatePath, readPrivateJson } from '../security.js';

/** Shared by the daemon writer and host-only bootstrap inspection. */
export function validateHostUpdateLedger(value: unknown): HostUpdateLedger {
  const ledger = hostUpdateLedgerSchema.parse(value);
  for (const operation of [ledger.current, ...ledger.history]) {
    for (const stage of operation?.stages ?? []) {
      if (digest(`${JSON.stringify(stage.record)}\n`) !== stage.digest)
        throw new Error('Host update stage receipt digest mismatch');
    }
  }
  return ledger;
}

/** No database or service is opened. Only existing owned legacy home permissions may migrate. */
export function readHostUpdateLedger(home: string): HostUpdateLedger {
  try {
    lstatSync(home); // Do not create a Puddle home just to report that no update exists.
    initialisePrivateHome(home);
    privatePath(join(home, 'updates'), true);
    return validateHostUpdateLedger(
      readPrivateJson(join(home, 'updates/operations.json'), HOST_UPDATE_RECORD_BYTES),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { format: 1, current: null, history: [] };
    throw error;
  }
}
