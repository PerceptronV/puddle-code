import {
  puddlangContextSchema,
  puddlangRunSchema,
  puddlangEventsSchema,
  puddlangOutcomesSchema,
  puddlangOutcomeResponseSchema,
  supportsApplicationFeature,
  type PuddlangOutcomeRequest,
  type PuddlangStart,
} from '@puddle/shared';
import { acquireAuthority, type ConnectionAuthority } from '../lib/auth/connection-authority.js';
import { DaemonClient } from '../lib/connection/daemon-client.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import { openTunnel, type Tunnel } from '../lib/transport/tunnel.js';
import { verifyDaemonVersion } from '../lib/connection/handshake.js';
import { HuddleClient } from '../huddle/client.js';

/** A profile is selected once, on the execution host; no credentials enter programmes. */
export class PuddlangClient {
  readonly huddles: HuddleClient;
  constructor(
    private readonly port: () => number,
    private readonly authority: ConnectionAuthority,
    readonly profile: string,
    private readonly protocol?: { major: number; minor: number },
  ) {
    this.huddles = new HuddleClient(
      (path, body) => this.request(path, body, 'huddle'),
      protocol,
      (path, body) => this.request(path, body, 'sessions'),
    );
  }

  private async request(
    path: string,
    body?: unknown,
    namespace: 'puddlang' | 'huddle' | 'sessions' = 'puddlang',
  ): Promise<unknown> {
    const response = await fetch(
      `http://127.0.0.1:${this.port()}/api/${namespace}${namespace === 'sessions' ? '' : '/' + encodeURIComponent(this.profile)}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.authority.credential()}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `${namespace === 'puddlang' ? 'Puddlang' : 'Huddle'} request failed (${response.status}): ${(await response.text()).slice(0, 2048)}`,
      );
    return response.json();
  }
  async context() {
    return puddlangContextSchema.parse(await this.request('/context'));
  }
  async start(input: PuddlangStart) {
    return puddlangRunSchema.parse(await this.request('/runs', input));
  }
  async status(id: string) {
    return puddlangRunSchema.parse(await this.request(`/runs/${encodeURIComponent(id)}`));
  }
  async events(id: string, after = 0) {
    return puddlangEventsSchema.parse(
      await this.request(`/runs/${encodeURIComponent(id)}/events?after=${after}`),
    );
  }
  async cancel(id: string) {
    return puddlangRunSchema.parse(
      await this.request(`/runs/${encodeURIComponent(id)}/cancel`, {}),
    );
  }
  private requireOutcomes(): void {
    if (!supportsApplicationFeature(this.protocol, { major: 26, minor: 1 }))
      throw new Error(
        'Programme outcome controls require daemon protocol 26.1 or newer within the current application major',
      );
  }
  async outcomes(id: string, after?: number) {
    this.requireOutcomes();
    return puddlangOutcomesSchema.parse(
      await this.request(
        `/runs/${encodeURIComponent(id)}/outcomes${after === undefined ? '' : `?after=${after}`}`,
      ),
    );
  }
  async disposeOutcome(id: string, operation: number, request: PuddlangOutcomeRequest) {
    this.requireOutcomes();
    return puddlangOutcomeResponseSchema.parse(
      await this.request(`/runs/${encodeURIComponent(id)}/outcomes/${operation}`, request),
    );
  }
}

export async function connectPuddlang(host?: string, selector?: string) {
  const transport = host ? new SshTransport(host) : new LocalTransport();
  let authority: Awaited<ReturnType<typeof acquireAuthority>> | undefined;
  let tunnel: Tunnel | undefined;
  const close = async () => {
    authority?.close();
    await tunnel?.close();
    transport.dispose();
  };
  try {
    if (transport instanceof SshTransport) await transport.open();
    authority = await acquireAuthority(transport);
    if (transport instanceof SshTransport) tunnel = await openTunnel(transport, authority.port);
    const port = () => tunnel?.localPort ?? authority!.port;
    const daemon = new DaemonClient(port(), authority);
    const { protocol } = verifyDaemonVersion(await daemon.version());
    const profiles = await daemon.profiles();
    const matches = selector
      ? profiles.filter((p) => p.id === selector || p.name === selector)
      : profiles;
    if (matches.length !== 1)
      throw new Error(
        `Select --profile on the execution host: ${profiles.map((p) => `${p.name} (${p.id})`).join(', ')}`,
      );
    return { client: new PuddlangClient(port, authority, matches[0]!.id, protocol), close };
  } catch (error) {
    await close();
    throw error;
  }
}
