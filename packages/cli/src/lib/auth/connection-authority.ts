import type { Duplex } from 'node:stream';
import {
  CONNECTION_POLICY,
  PROTOCOL_VERSION,
  controlResponseSchema,
  type ControlRequest,
  type VersionResponse,
} from '@puddle/shared';
import { jsonLines, secret } from '@puddle/shared/node';
import type { Transport } from '../transport/transport.js';
import { CliError } from '../types.js';
import { openControlChannel } from './control-channel.js';

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
export class HostConnection implements ConnectionAuthority {
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

  constructor(private readonly transport: Transport) {
    this.timer = setInterval(() => {
      if (this.channel && performance.now() >= this.until)
        this.lose(this.channel, 'upstream_expired');
      if (!this.channel && !this.connecting && !this.stopped) void this.establish().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  setTransportAvailable(available: boolean): void {
    if (!available && this.channel) this.lose(this.channel);
    if (available && !this.stopped) void this.establish().catch(() => {});
  }
  /** Run after every replacement control generation before reopening the gateway. */
  setVerifier(verifier: () => Promise<void>): void {
    this.verifier = verifier;
  }
  credential(): string {
    if (!this.token || performance.now() >= this.until)
      throw new CliError('daemon_unreachable', 'connection authority is unavailable');
    return this.token;
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
      const channel = await openControlChannel(this.transport);
      if (this.stopped) {
        channel.destroy();
        return;
      }
      this.channel = channel;
      this.until = performance.now() + CONNECTION_POLICY.leaseMs;
      await new Promise<void>((resolve, reject) => {
        let pendingAt: number | null = null;
        let initial = true;
        const send = (message: ControlRequest) => {
          pendingAt = performance.now();
          channel.write(JSON.stringify(message) + '\n');
        };
        const beat = setInterval(() => {
          if (pendingAt === null) send({ t: 'renew', resources: [...this.resources.keys()] });
        }, CONNECTION_POLICY.participationMs);
        beat.unref();
        const stop = jsonLines(
          channel,
          (value) => {
            if (this.channel !== channel || pendingAt === null) return channel.destroy();
            const message = controlResponseSchema.parse(value);
            if (message.t !== 'authority') {
              channel.destroy();
              return;
            }
            if (message.version.protocol.major !== PROTOCOL_VERSION.major) {
              this.status = 'protocol_mismatch';
              reject(
                new CliError(
                  'cli_outdated',
                  `Host protocol ${message.version.protocol.major} requires a compatible CLI`,
                ),
              );
              channel.destroy();
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
          reject(new CliError('daemon_unreachable', 'Host control channel is unavailable'));
        };
        channel.once('error', closed);
        channel.once('close', closed);
        channel.once('end', closed);
        send({ t: 'open' });
      });
    } finally {
      this.connecting = false;
    }
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
