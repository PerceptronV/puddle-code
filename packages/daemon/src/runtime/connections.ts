import type { RuntimeBinding, RuntimeStore } from '../db/stores/runtimes.js';
import type { RuntimeIdentity } from '@puddle/shared';
import { connectRuntimeOwner } from './discovery.js';
import type { RuntimeClient } from './client.js';
import { acquireRuntimeController } from './storage.js';

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
export class RuntimeConnections {
  private readonly controller: ReturnType<typeof acquireRuntimeController>;
  private readonly clients = new Map<string, RuntimeClient>();
  private readonly unavailable = new Set<string>();
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly home: string,
    private readonly store: RuntimeStore,
    private readonly onConnect?: (id: string, client: RuntimeClient) => Promise<void>,
  ) {
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
    if (this.connecting) return this.connecting;
    this.connecting = this.inspect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async inspect(): Promise<void> {
    const pending = this.store.live();
    let index = 0;
    const worker = async () => {
      while (!this.closed && index < pending.length) {
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
          if (this.closed) {
            client.close();
            return;
          }
          this.clients.set(binding.runtime_id, client);
          this.unavailable.delete(binding.runtime_id);
          client.once('disconnected', () => {
            if (this.clients.get(binding.runtime_id) !== client) return;
            this.clients.delete(binding.runtime_id);
            if (!this.closed) this.unavailable.add(binding.runtime_id);
          });
          await this.onConnect?.(binding.runtime_id, client);
        } catch {
          // Malformed records, a timeout and incompatible owners all preserve
          // ownership. Only exclusive retirement can establish process loss.
          if (!this.closed) this.unavailable.add(binding.runtime_id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    try {
      await this.connecting;
    } finally {
      this.controller.release();
    }
  }
}
