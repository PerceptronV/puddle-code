import { HostControlClient } from '@puddle/shared/node/host-control';
import type { Transport } from '../transport/transport.js';
import { CliError } from '../types.js';
import { openControlChannel } from './control-channel.js';
export type { AuthorityState, ConnectionAuthority } from '@puddle/shared/node/host-control';

/** The local/SSH shell is itself the participating client. */
export class HostConnection extends HostControlClient {
  constructor(transport: Transport) {
    super(
      () => openControlChannel(transport),
      true,
      (code, message) => new CliError(code, message),
    );
  }
}
export async function acquireAuthority(transport: Transport): Promise<HostConnection> {
  const authority = new HostConnection(transport);
  try {
    await authority.establish();
    return authority;
  } catch (err) {
    authority.close();
    throw err;
  }
}
