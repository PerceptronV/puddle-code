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
  private readonly clients = new Map<string, RuntimeClient>();
  private readonly unavailable = new Set<string>();
  private connecting: Promise<void> | null = null;
  private readonly attaching = new Map<string, Promise<void>>();
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
    // Offline maintenance acquires ownership before opening the application database.
    private readonly controller = acquireRuntimeController(home),
  ) {
    super();
  }

  get(id: string): RuntimeClient | null {
    return this.clients.get(id) ?? null;
  }

  unavailableIds(): string[] {
    return [...this.unavailable];
  }

  /** Public controller identity only, while this daemon still holds admission and ownership. */
  controllerIdentity(): Pick<RuntimeControllerRecord, 'id' | 'epoch'> | null {
    if (this.closed || this.released) return null;
    return { id: this.controller.record.id, epoch: this.controller.record.epoch };
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

  /** A new launch must not wait for unrelated owners' discovery/recovery probes. */
  connectOwner(id: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Runtime connections are closed'));
    if (this.paused) return Promise.reject(new Error('Runtime connection discovery is paused'));
    return this.admission
      .run(async () => {
        const binding = this.store.get(id);
        if (binding && ['prepared', 'running'].includes(binding.state)) await this.attach(binding);
      })
      .finally(() => this.schedule());
  }

  private attach(binding: RuntimeBinding): Promise<void> {
    const id = binding.runtime_id;
    const pending = this.attaching.get(id);
    if (pending) return pending;
    if (this.clients.has(id)) return Promise.resolve();
    const task = this.attachBinding(binding).finally(() => this.attaching.delete(id));
    this.attaching.set(id, task);
    return task;
  }

  private async attachBinding(binding: RuntimeBinding): Promise<void> {
    const id = binding.runtime_id;
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
        if (!this.closed) this.unavailable.add(id);
        return;
      }
      this.clients.set(id, client);
      this.unavailable.delete(id);
      this.retryMs = 0;
      client.once('disconnected', () => {
        if (this.clients.get(id) !== client) return;
        this.clients.delete(id);
        this.emit('disconnected', id);
        if (!this.closed) {
          this.unavailable.add(id);
          this.schedule();
        }
      });
      await this.handlers.connected?.(id, client);
      // Already-admitted attachment installs listeners before pause drains.
      if (!this.closed && this.clients.get(id) === client) this.emit('connected', id, client);
    } catch {
      this.clients.get(id)?.close();
      // A failed observation never proves ownership has ended.
      if (!this.closed && !this.paused) {
        this.unavailable.add(id);
        try {
          if (await this.handlers.missing?.(id)) this.unavailable.delete(id);
        } catch {
          // Storage errors retain ownership for a later retry.
        }
      }
    }
  }

  private async inspect(): Promise<void> {
    const pending = this.store.live();
    let index = 0;
    const worker = async () => {
      while (!this.closed && !this.paused && index < pending.length)
        await this.attach(pending[index++]!);
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
