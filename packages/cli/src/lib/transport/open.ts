import { LocalTransport } from './local.js';
import { SshTransport } from './ssh.js';
import type { Transport } from './transport.js';

/** Shared component/maintenance transport; opening it never starts a daemon. */
export async function openHostTransport(host: string | undefined): Promise<Transport> {
  const transport =
    host === undefined || host === 'local' ? new LocalTransport() : new SshTransport(host);
  if (transport instanceof SshTransport) {
    try {
      await transport.open();
    } catch (error) {
      transport.dispose();
      throw error;
    }
  }
  return transport;
}
