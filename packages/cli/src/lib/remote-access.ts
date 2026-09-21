import {
  cockpitRemoteRequestSchema,
  cockpitRemoteStatusSchema,
  remoteAdminResponseSchema,
  type CockpitRemoteRequest,
  type CockpitRemoteStatus,
  type RemoteAdminResponse,
} from '@puddle/shared';
import { hostPaths } from './paths.js';
import type { Transport } from './transport/transport.js';

const binary = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/connector.mjs`;

/** Fixed host commands only; browser values travel exclusively through JSON stdin. */
export class RemoteAccessControl {
  constructor(private readonly transport: Transport) {}

  private async availability(): Promise<CockpitRemoteStatus['availability']> {
    const result = await this.transport.exec(
      `if test -f ${hostPaths.current}/daemon/connector.mjs; then ${binary} --version; else exit 44; fi`,
      { timeoutMs: 10_000 },
    );
    if (result.code === 44) return 'not_installed';
    if (result.code !== 0)
      throw new Error('Host control is unavailable. Check the host connection.');
    return result.stdout.includes('cockpit controls 1') ? 'ready' : 'upgrade_required';
  }

  async status(): Promise<CockpitRemoteStatus> {
    const availability = await this.availability();
    if (availability !== 'ready')
      return {
        availability,
        configured: false,
        enabled: false,
        connected: false,
        supervisor: null,
        devices: [],
      };
    const result = await this.transport.exec(`${binary} --inspect`, { timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error('Could not read remote access status on this host.');
    return cockpitRemoteStatusSchema.parse(JSON.parse(result.stdout));
  }

  async request(
    value: CockpitRemoteRequest,
    authorised: () => boolean,
  ): Promise<RemoteAdminResponse> {
    const request = cockpitRemoteRequestSchema.parse(value);
    if ((await this.availability()) !== 'ready')
      throw new Error('Upgrade the daemon on this host to manage remote access here.');
    if (!authorised()) throw new Error('Browser authorisation expired before dispatch.');
    const flag =
      request.t === 'enable' ? '--configure' : request.t === 'reset' ? '--reset' : '--admin';
    const payload = request.t === 'enable' ? { ...request.registration, managed: true } : request;
    const result = await this.transport.exec(`${binary} ${flag}`, {
      stdin: JSON.stringify(payload) + '\n',
      timeoutMs: 30_000,
    });
    // Do not reflect subprocess output: it can contain a registration code or invitation.
    if (result.code !== 0)
      throw new Error(
        request.t === 'enable'
          ? 'Could not enable remote access. Check the origins, an unused registration code and persistent host supervision. Refresh status before retrying.'
          : 'The host operation failed or was interrupted. Refresh status before retrying.',
      );
    if (request.t === 'reset') return { enabled: false, connected: false };
    const response = remoteAdminResponseSchema.parse(JSON.parse(result.stdout));
    if (response.error) throw new Error(response.error);
    return response;
  }
}
