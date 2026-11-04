import {
  hostUpdateCommandSchema,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '@puddle/shared';
import { readHostUpdateLedger } from '@puddle/shared/node/host-control';

/** Host OS/SSH authority only; never substitutes stored evidence for a live adoption receipt. */
export function inspectStoredHostUpdate(home: string, input: HostUpdateCommand): HostUpdateReply {
  const command = hostUpdateCommandSchema.parse(input);
  if (command.action !== 'status' || command.adoption_nonce)
    return { ok: false, code: 'unsupported', operation: null };
  try {
    const ledger = readHostUpdateLedger(home);
    const operation =
      command.id === undefined || ledger.current?.id === command.id
        ? ledger.current
        : (ledger.history.find((item) => item.id === command.id) ?? null);
    return { ok: true, operation };
  } catch {
    return { ok: false, code: 'failed', operation: null };
  }
}
