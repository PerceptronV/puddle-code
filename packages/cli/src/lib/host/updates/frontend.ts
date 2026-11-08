import {
  PROTOCOL_VERSION,
  supportsApplicationFeature,
  frontendHostUpdateRequestSchema,
  frontendHostUpdateStatusSchema,
  type FrontendHostUpdateReply,
  type FrontendHostUpdateRequest,
  type FrontendHostUpdateStatus,
  type HostUpdateCommand,
} from '@puddle/shared';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import type { Transport } from '../../transport/transport.js';
import { prepareHostUpdate } from '../../installation/host/updates.js';
import { HostConnection } from '../../auth/connection-authority.js';
import { inspectHostUpdate, continueHostUpdate } from '../../auth/control-channel.js';
import { presentHostUpdate } from '@puddle/shared';
import { offersOfflineContinuation } from './continuation.js';

type Authority = Pick<
  HostControlClient,
  'state' | 'generation' | 'version' | 'hostUpdate' | 'onChange'
>;

/** Selected transport and browser authority; live mutations also retain a child daemon lease. */
export class FrontendHostUpdates {
  constructor(
    private readonly transport: Transport,
    private readonly authority: Authority,
  ) {}

  private supports(minor: number): boolean {
    const protocol = this.authority.version?.protocol;
    return supportsApplicationFeature(protocol, { major: 25, minor });
  }

  private guarded(authorised: () => boolean, authority = this.authority) {
    const generation = authority.generation;
    return {
      get generation() {
        return authority.generation;
      },
      get state() {
        return authorised() ? authority.state : 'upstream_expired';
      },
      hostUpdate(command: HostUpdateCommand) {
        if (
          !authorised() ||
          !generation ||
          authority.generation !== generation ||
          authority.state !== 'ready'
        )
          throw new Error('Host update authority changed before dispatch');
        return authority.hostUpdate(command);
      },
    } satisfies Pick<HostControlClient, 'generation' | 'state' | 'hostUpdate'>;
  }

  async status(
    id: string | undefined,
    authorised: () => boolean,
    signal: AbortSignal,
    components = false,
  ): Promise<FrontendHostUpdateStatus> {
    if (!authorised() || signal.aborted) throw new Error('Browser authorisation expired');
    const generation = this.authority.generation;
    const availability =
      this.authority.state !== 'ready'
        ? 'unavailable'
        : this.supports(7)
          ? 'ready'
          : 'upgrade_required';
    const capabilities = {
      interruption_approval: availability === 'ready' && this.supports(10),
      verify_completion: availability === 'ready' && this.supports(11),
      continue_recovery: availability === 'ready' && this.supports(12),
    };
    const reply =
      availability === 'ready'
        ? await this.withAuthority(authorised, signal, async (authority) =>
            authority.hostUpdate({
              action: 'status',
              ...(id ? { id } : {}),
              ...(capabilities.continue_recovery ? { include_recovery: true } : {}),
              ...(this.supports(14) ? { include_catalogue: true } : {}),
              ...(components &&
              supportsApplicationFeature(this.authority.version?.protocol, { major: 26, minor: 2 })
                ? { include_component_releases: true }
                : {}),
            }),
          )
        : availability === 'unavailable'
          ? await inspectHostUpdate(this.transport, id, true)
          : null;
    if (!authorised() || signal.aborted) throw new Error('Browser authorisation expired');
    if (
      this.authority.generation !== generation ||
      (availability === 'unavailable' && this.authority.state === 'ready')
    )
      throw new Error('Host connection changed during status inspection');
    return frontendHostUpdateStatusSchema.parse({
      availability,
      ...(availability === 'ready'
        ? { observation: 'live' }
        : availability === 'unavailable'
          ? { observation: 'recorded' }
          : {}),
      daemon_version: this.authority.version?.version ?? null,
      capabilities: {
        ...capabilities,
        ...(availability === 'unavailable' &&
        this.authority.state !== 'protocol_mismatch' &&
        reply?.ok &&
        offersOfflineContinuation(reply.operation)
          ? { offline_continuation: true }
          : {}),
      },
      result: reply ? presentHostUpdate(reply) : null,
      ...(reply?.ok && reply.catalogue ? { catalogue: reply.catalogue } : {}),
    });
  }

  async request(
    input: FrontendHostUpdateRequest,
    authorised: () => boolean,
    signal: AbortSignal,
  ): Promise<FrontendHostUpdateReply> {
    const request = frontendHostUpdateRequestSchema.parse(input);
    if (request.action === 'continue-offline')
      return this.continueOffline(request.reference, authorised, signal);
    if (!this.supports(7)) throw new Error('Host update controls require a newer daemon');
    if (request.action === 'apply' && request.interruption_approval && !this.supports(10))
      throw new Error('This host cannot approve daemon-owned interruption');
    if (request.action === 'recover' && !this.supports(request.strategy === 'continue' ? 12 : 11))
      throw new Error('This host does not support the requested recovery action');
    return this.withAuthority(authorised, signal, async (authority) => {
      if (request.action === 'prepare') {
        let repository: string | undefined;
        if (this.supports(14)) {
          const status = await authority.hostUpdate({ action: 'status', include_catalogue: true });
          if (!status.ok || !status.catalogue?.releases.repository)
            throw new Error('No release source is configured on this host');
          repository = status.catalogue.releases.repository;
        }
        const operation = await prepareHostUpdate(
          this.transport,
          authority,
          request.targets,
          repository ? { repository } : {},
        );
        if (!authorised()) throw new Error('Browser authorisation expired');
        return presentHostUpdate({ ok: true, operation });
      }
      const command: HostUpdateCommand =
        request.action === 'cancel'
          ? { ...request, reason: 'cancelled' }
          : request.action === 'inspect' || request.action === 'apply'
            ? { ...request, frontend: PROTOCOL_VERSION }
            : request;
      // One explicit request. A lost reply is uncertain; status never dispatches a replacement.
      const reply = await authority.hostUpdate(command);
      if (!authorised()) throw new Error('Browser authorisation expired');
      return presentHostUpdate(reply);
    });
  }

  private async continueOffline(
    reference: Extract<FrontendHostUpdateRequest, { action: 'continue-offline' }>['reference'],
    authorised: () => boolean,
    signal: AbortSignal,
  ) {
    const generation = this.authority.generation;
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal]);
    const valid = () =>
      !combined.aborted &&
      authorised() &&
      this.authority.generation === generation &&
      ['upstream_unavailable', 'upstream_expired'].includes(this.authority.state);
    if (!valid()) throw new Error('Offline recovery requires an unavailable daemon connection');
    const unwatch = this.authority.onChange(() => {
      if (!valid()) lifetime.abort();
    });
    try {
      const reply = await continueHostUpdate(this.transport, reference, {
        signal: combined,
        authorised: valid,
      });
      if (!valid()) throw new Error('Host recovery authority changed');
      return presentHostUpdate(reply);
    } finally {
      unwatch();
      lifetime.abort();
    }
  }

  private async withAuthority<T>(
    authorised: () => boolean,
    signal: AbortSignal,
    action: (authority: ReturnType<FrontendHostUpdates['guarded']>) => Promise<T>,
  ): Promise<T> {
    const generation = this.authority.generation;
    const valid = () =>
      !signal.aborted &&
      authorised() &&
      !!generation &&
      this.authority.state === 'ready' &&
      this.authority.generation === generation;
    if (!valid()) throw new Error('Host update authority is unavailable');
    // The shared frontend lease serves other windows. A child channel lets revocation
    // reach the host's final pre-dispatch check without revoking those other viewers.
    // Status polls also use a short-lived channel so they cannot exhaust the shared
    // connection's bounded request-id history and permanently disable host control.
    const child = new HostConnection(this.transport);
    const close = () => child.close();
    const unwatch = this.authority.onChange(() => {
      if (!valid()) close();
    });
    signal.addEventListener('abort', close, { once: true });
    try {
      if (!valid()) throw new Error('Host update authority changed');
      await child.establish();
      if (!valid()) throw new Error('Host update authority changed');
      return await action(this.guarded(valid, child));
    } finally {
      signal.removeEventListener('abort', close);
      unwatch();
      close();
    }
  }
}
