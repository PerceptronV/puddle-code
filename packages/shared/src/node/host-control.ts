export {
  latestComponentReleases,
  componentReleaseAt,
  releaseManifest,
} from './releases/components.js';
import { HostUpdateOnlyScope, type HostUpdateConnectionScope } from './control/update-authority.js';
export type { HostUpdateConnectionScope } from './control/update-authority.js';
export {
  readStageCapabilities,
  readInstalledCapabilities,
  readStageDaemonRuntimeCapabilities,
  readInstalledDaemonRuntimeCapabilities,
} from './installation/capabilities.js';
export { readHostBootIdentity } from './installation/boot.js';
export {
  latestGitHubRelease,
  releaseRepositorySchema,
  type ReleaseAsset,
} from './releases/github.js';
export { releaseRepository } from './releases/source.js';
export { updateWorkerExecutables } from './installation/workers.js';
export { requireNoHostRemoval } from './installation/removal.js';
export {
  inspectHostRemoval,
  validateHostRemovalServices,
  readPurgedHostRemoval,
} from './installation/removal-records.js';
export {
  hostPurgeFingerprint,
  readHostPurgeRecord,
  validateHostPurgeRecord,
  requireArchivedHostPurge,
} from './installation/purge.js';
export { watchUpdateParticipation } from './installation/participation.js';
export { HostUpdateRequests } from './control/updates.js';
export { HOST_CONTROL_REQUEST_LIMITS } from './control/requests.js';
export {
  prepareHostUpdateOperation,
  HostUpdatePreparationError,
} from './installation/preparation.js';
export { validateHostStageReceipt, parseHostStageOutput } from './installation/stage-receipt.js';
import type { Duplex } from 'node:stream';
import {
  CONNECTION_POLICY,
  REMOTE_POLICY,
  PROTOCOL_VERSION,
  controlResponseSchema,
  type ControlRequest,
  type VersionResponse,
  type HostUpdateCommand,
  type HostUpdateReply,
  hostMaintenanceCommandSchema,
  remoteMaintenanceClaimSchema,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
  type RemoteMaintenanceClaim,
} from '../index.js';
import { jsonLines, secret } from './security.js';
import { HostUpdateRequests } from './control/updates.js';
import { HostControlRequests } from './control/requests.js';
export {
  readUpdateRecoveryAttempts,
  updateRecoveryDirectory,
  inspectRecordedRecovery,
} from './installation/recovery.js';
export { readHostUpdateLedger, validateHostUpdateLedger } from './installation/updates.js';

export type AuthorityState =
  'ready' | 'upstream_expired' | 'upstream_unavailable' | 'protocol_mismatch';
export interface ConnectionAuthority {
  readonly state: AuthorityState;
  readonly generation: string | null;
  credential(): string;
  resource(close: () => void): { id: string; release(): void; valid(): boolean };
  onChange(cb: () => void): () => void;
  close(): void;
}

/** One client-participating control channel, independent of SSH forwarding pids. */
export class HostControlClient implements ConnectionAuthority {
  private status: AuthorityState = 'upstream_unavailable';
  get state(): AuthorityState {
    if (this.channel && performance.now() >= this.until)
      this.lose(this.channel, 'upstream_expired');
    return this.status;
  }
  generation: string | null = null;
  port = 0;
  version: VersionResponse | null = null;
  private token: string | null = null;
  private until = 0;
  private channel: Duplex | null = null;
  private stopped = false;
  private connecting = false;
  private readonly resources = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private verifier: (() => Promise<void>) | null = null;
  private updates: HostUpdateRequests | null = null;
  private maintenanceRequests: HostControlRequests<
    HostMaintenanceCommand,
    HostMaintenanceReply
  > | null = null;

  private readonly updateOnly: HostUpdateOnlyScope | null;

  private renewControl: ((resources: string[], sentAt: number) => boolean) | null = null;

  constructor(
    private readonly openChannel: () => Promise<Duplex>,
    private readonly automatic = true,
    private readonly error: (
      code: 'daemon_unreachable' | 'protocol_mismatch',
      message: string,
    ) => Error = (_code, message) => new Error(message),
    private readonly profile?: string,
    private readonly maintenance?: RemoteMaintenanceClaim,
    updateScope?: HostUpdateConnectionScope,
  ) {
    if (updateScope && (profile || maintenance))
      throw new Error('Host update migration cannot carry profile or remote authority');
    this.updateOnly = updateScope ? new HostUpdateOnlyScope(updateScope) : null;
    if (maintenance) {
      if (!profile) throw new Error('Remote maintenance requires a profile');
      this.maintenance = remoteMaintenanceClaimSchema.parse(maintenance);
      this.automatic = false;
    }
    this.timer = setInterval(() => {
      if (this.channel && performance.now() >= this.until)
        this.lose(this.channel, 'upstream_expired');
      if (this.automatic && !this.channel && !this.connecting && !this.stopped)
        void this.establish().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  setTransportAvailable(available: boolean): void {
    if (!available && this.channel) this.lose(this.channel);
    if (available && !this.stopped) void this.establish().catch(() => {});
  }
  /** Run after every replacement control generation before reopening the gateway. */
  setVerifier(verifier: () => Promise<void>): void {
    if (this.updateOnly)
      throw new Error('Host update migration cannot open an application gateway');
    this.verifier = verifier;
  }
  credential(): string {
    if (this.updateOnly) throw new Error('Host update migration has no application credential');
    if (!this.token || performance.now() >= this.until)
      throw this.error('daemon_unreachable', 'connection authority is unavailable');
    return this.token;
  }
  /** Private local/SSH maintenance; renewal remains independently client-participating. */
  hostUpdate(command: HostUpdateCommand): Promise<HostUpdateReply> {
    const protocol = this.version?.protocol;
    if (
      this.profile ||
      !protocol ||
      protocol.major < 25 ||
      (protocol.major === 25 && protocol.minor < 7)
    )
      return Promise.reject(new Error('Host updates are unavailable on this connection'));
    if (
      command.action === 'status' &&
      command.include_catalogue &&
      protocol.major === 25 &&
      protocol.minor < 14
    )
      return Promise.reject(new Error('Host update catalogue is unavailable on this connection'));
    if (
      command.action === 'status' &&
      command.adoption_nonce &&
      protocol.major === 25 &&
      protocol.minor < 8
    )
      return Promise.reject(
        new Error('Host adoption inspection is unavailable on this connection'),
      );
    if (
      command.action === 'apply' &&
      command.interruption_approval &&
      protocol.major === 25 &&
      protocol.minor < 10
    )
      return Promise.reject(
        new Error('Host interruption approval is unavailable on this connection'),
      );
    if (command.action === 'recover' && protocol.major === 25 && protocol.minor < 11)
      return Promise.reject(
        new Error('Host recovery verification is unavailable on this connection'),
      );
    if (
      ((command.action === 'recover' && command.strategy === 'continue') ||
        (command.action === 'status' && command.include_recovery)) &&
      protocol.major === 25 &&
      protocol.minor < 12
    )
      return Promise.reject(
        new Error('Host update continuation is unavailable on this connection'),
      );
    if (this.state !== 'ready' || !this.updates)
      return Promise.reject(new Error('Host control is unavailable'));
    try {
      this.updateOnly?.before(command);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.updates.request(command).then((reply) => {
      this.updateOnly?.observed(reply);
      return reply;
    });
  }
  /** A separate manually participating profile channel; never grants host-wide update access. */
  hostMaintenance(command: HostMaintenanceCommand): Promise<HostMaintenanceReply> {
    if (!this.profile || !this.maintenance || !this.version || this.version.protocol.major < 26)
      return Promise.reject(new Error('Host maintenance is unavailable on this connection'));
    if (this.state !== 'ready' || !this.maintenanceRequests)
      return Promise.reject(new Error('Host control is unavailable'));
    return this.maintenanceRequests.request(command);
  }
  resource(close: () => void) {
    this.credential();
    const generation = this.generation;
    const id = secret();
    this.resources.set(id, close);
    return {
      id,
      release: () => {
        this.resources.delete(id);
      },
      valid: () => {
        const valid =
          this.generation === generation &&
          this.resources.has(id) &&
          performance.now() < this.until;
        if (!valid) close();
        return valid;
      },
    };
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async establish(): Promise<void> {
    if (this.stopped || this.connecting || this.channel) return;
    this.connecting = true;
    try {
      const channel = await this.openChannel();
      if (this.stopped) {
        channel.destroy();
        return;
      }
      this.channel = channel;
      const updates = new HostUpdateRequests(channel);
      this.updates = updates;
      const maintenance = new HostControlRequests<HostMaintenanceCommand, HostMaintenanceReply>(
        channel,
        {
          type: 'host-maintenance',
          parse: hostMaintenanceCommandSchema.parse,
          timeoutMs: REMOTE_POLICY.maintenanceRequestMs,
        },
      );
      this.maintenanceRequests = maintenance;
      this.until = performance.now() + CONNECTION_POLICY.leaseMs;
      await new Promise<void>((resolve, reject) => {
        let pendingAt: number | null = null;
        let initial = true;
        const send = (message: ControlRequest, sentAt = performance.now()) => {
          pendingAt = sentAt;
          channel.write(JSON.stringify(message) + '\n');
        };
        this.renewControl = (resources, sentAt) => {
          if (pendingAt !== null || this.channel !== channel || this.state !== 'ready')
            return false;
          if (resources.some((id) => !this.resources.has(id))) return false;
          send({ t: 'renew', resources }, sentAt);
          return true;
        };
        const beat = setInterval(() => {
          if (this.automatic) this.participate([...this.resources.keys()]);
        }, CONNECTION_POLICY.participationMs);
        beat.unref();
        const stop = jsonLines(
          channel,
          (value) => {
            if (this.channel !== channel) return channel.destroy();
            const message = controlResponseSchema.parse(value);
            if (message.t === 'host-update-result') {
              if (!updates.receive(message)) channel.destroy();
              return;
            }
            if (message.t === 'host-maintenance-result') {
              if (!maintenance.receive(message)) channel.destroy();
              return;
            }
            if (pendingAt === null) return channel.destroy();
            if (message.t !== 'authority') {
              channel.destroy();
              return;
            }
            if (
              this.updateOnly
                ? !this.updateOnly.accepts(message.version)
                : message.version.protocol.major !== PROTOCOL_VERSION.major
            ) {
              this.status = 'protocol_mismatch';
              reject(
                this.error(
                  'protocol_mismatch',
                  this.updateOnly
                    ? 'Host identity changed outside the approved update migration'
                    : `Host protocol ${message.version.protocol.major} does not match client protocol ${PROTOCOL_VERSION.major}`,
                ),
              );
              if (this.updateOnly) this.close();
              else channel.destroy();
              return;
            }
            if (!initial && message.generation !== this.generation) return channel.destroy();
            this.until = pendingAt + message.validForMs;
            pendingAt = null;
            if (performance.now() >= this.until) return channel.destroy();
            if (message.token) this.token = message.token;
            if (!this.token) return channel.destroy();
            this.generation = message.generation;
            this.port = message.port;
            this.version = message.version;
            if (initial) {
              initial = false;
              void (this.verifier?.() ?? Promise.resolve())
                .then(() => {
                  if (this.channel !== channel) return;
                  this.status = 'ready';
                  this.emit();
                  resolve();
                })
                .catch(() => channel.destroy());
            }
          },
          () => channel.destroy(),
        );
        const closed = () => {
          stop();
          clearInterval(beat);
          this.lose(channel);
          reject(this.error('daemon_unreachable', 'Host control channel is unavailable'));
        };
        channel.once('error', closed);
        channel.once('close', closed);
        channel.once('end', closed);
        send({
          t: 'open',
          ...(this.profile ? { profile: this.profile } : {}),
          ...(this.maintenance ? { maintenance: this.maintenance } : {}),
        });
      });
    } finally {
      this.connecting = false;
    }
  }
  /** External participation is anchored to the challenge's issue time, never a delayed reply. */
  participate(resources: string[], sentAt = performance.now()): boolean {
    if (
      sentAt > performance.now() ||
      performance.now() - sentAt >= CONNECTION_POLICY.participationMs
    )
      return false;
    return this.renewControl?.(resources, sentAt) ?? false;
  }
  close(): void {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.channel) {
      this.channel.write(JSON.stringify({ t: 'close' }) + '\n');
      this.lose(this.channel);
    }
  }
  private lose(channel: Duplex, state: AuthorityState = 'upstream_unavailable'): void {
    if (this.channel !== channel) return;
    this.channel = null;
    this.renewControl = null;
    this.updates?.close();
    this.updates = null;
    this.maintenanceRequests?.close();
    this.maintenanceRequests = null;
    this.token = null;
    this.generation = null;
    if (this.status !== 'protocol_mismatch') this.status = state;
    const callbacks = [...this.resources.values()];
    this.resources.clear();
    channel.destroy();
    for (const close of callbacks) close();
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
