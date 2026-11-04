import { EventEmitter } from 'node:events';
import type { RuntimeBinding, RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeIdentity, RuntimeControllerRecord } from '@puddle/shared';
import { connectRuntimeOwner } from '../ownership/discovery.js';
import type { RuntimeClient } from './client.js';
import { acquireRuntimeController } from '../ownership/storage.js';
import { HostAdmission } from '../../host/lifecycle/admission.js';

export function runtimeBindingIdentity(binding: RuntimeBinding): RuntimeIdentity {
  return {
    runtime_id: binding.runtime_id,
    incarnation: binding.incarnation,
    launch_id: binding.launch_id,
    profile_id: binding.profile_id,
    project_id: binding.project_id,
    session_id: binding.launch_session_id,
    canonical_worktree_path: binding.canonical_worktree_path,
  };
}

/**
 * Daemon-lifetime control connections. Inspection is the first adoption step,
 * never permission to resume or discard retained observations. SQLite bindings
 * remain authoritative until the event reconciler commits their outcomes.
 */
export class RuntimeConnections extends EventEmitter {
  private readonly controller: ReturnType<typeof acquireRuntimeController>;
  private readonly clients = new Map<string, RuntimeClient>();
  private readonly unavailable = new Set<string>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private released = false;
  private paused = false;
  private readonly admission = new HostAdmission();
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = 0;

  constructor(
    private readonly home: string,
    private readonly store: RuntimeStore,
    private readonly handlers: {
      connected?: (id: string, client: RuntimeClient) => Promise<void>;
      missing?: (id: string) => Promise<boolean>;
    } = {},
  ) {
    super();
    this.controller = acquireRuntimeController(home);
  }

  get(id: string): RuntimeClient | null {
    return this.clients.get(id) ?? null;
  }

  unavailableIds(): string[] {
    return [...this.unavailable];
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Runtime connections are closed'));
    if (this.paused) return Promise.reject(new Error('Runtime connection discovery is paused'));
    if (this.connecting) return this.connecting;
    this.connecting = this.admission.run(() =>
      this.inspect().finally(() => {
        this.connecting = null;
        this.schedule();
      }),
    );
    return this.connecting;
  }

  private schedule(): void {
    if (
      this.closed ||
      this.paused ||
      this.connecting ||
      this.retryTimer ||
      this.unavailable.size === 0
    )
      return;
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 1000, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch(() => {
        // Database inspection can fail too; the pending owners remain protected.
      });
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private async inspect(): Promise<void> {
    const pending = this.store.live();
    let index = 0;
    const worker = async () => {
      while (!this.closed && !this.paused && index < pending.length) {
        const binding = pending[index++]!;
        if (this.clients.has(binding.runtime_id)) continue;
        try {
          const client = await connectRuntimeOwner(
            this.home,
            runtimeBindingIdentity(binding),
            this.controller.record,
          );
          if (
            client.state?.build !== binding.build ||
            client.state.protocol.major !== binding.protocol_major ||
            client.state.protocol.minor !== binding.protocol_minor
          ) {
            client.close();
            throw new Error('Runtime build does not match its committed launch');
          }
          if (this.closed || this.paused) {
            client.close();
            if (!this.closed) this.unavailable.add(binding.runtime_id);
            return;
          }
          this.clients.set(binding.runtime_id, client);
          this.unavailable.delete(binding.runtime_id);
          this.retryMs = 0;
          client.once('disconnected', () => {
            if (this.clients.get(binding.runtime_id) !== client) return;
            this.clients.delete(binding.runtime_id);
            this.emit('disconnected', binding.runtime_id);
            if (!this.closed) {
              this.unavailable.add(binding.runtime_id);
              this.schedule();
            }
          });
          await this.handlers.connected?.(binding.runtime_id, client);
          // This already-admitted attachment must finish installing its output
          // listeners before the pause's drain resolves.
          if (!this.closed && this.clients.get(binding.runtime_id) === client)
            this.emit('connected', binding.runtime_id, client);
        } catch {
          this.clients.get(binding.runtime_id)?.close();
          // Malformed records, a timeout and incompatible owners all preserve
          // ownership. Only exclusive retirement can establish process loss.
          if (!this.closed && !this.paused) {
            this.unavailable.add(binding.runtime_id);
            try {
              if (await this.handlers.missing?.(binding.runtime_id))
                this.unavailable.delete(binding.runtime_id);
            } catch {
              // Incomplete history/storage errors retain ownership for a later retry.
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  }

  /** Stop discovery/retirement work while retaining established owner connections. */
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let released = false;
    return {
      drain: (timeoutMs) => hold.drain(timeoutMs),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        // Scan all bindings: a paused sweep may never have reached some owners.
        if (!this.closed) void this.connect().catch(() => {});
      },
    };
  }

  async close(beforeRelease?: (controller: RuntimeControllerRecord) => void): Promise<void> {
    this.closed = true;
    this.admission.close();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    // A timeout does not establish that admitted callbacks stopped using SQLite.
    await this.admission.drain();
    if (this.released) {
      if (beforeRelease) throw new Error('Runtime controller ownership was already released');
      return;
    }
    beforeRelease?.({ ...this.controller.record });
    this.controller.release();
    this.released = true;
  }
}
