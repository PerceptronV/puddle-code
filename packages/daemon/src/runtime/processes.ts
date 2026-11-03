import type { RuntimeEvent } from '@puddle/shared';
import type { RuntimeStore } from '../db/stores/runtimes.js';
import type { PortProcessSnapshot } from '../ports/scanner.js';
import type { RuntimeClient } from './client.js';
import type { RuntimeConnections } from './connections.js';

/** Live authenticated process inventory, fenced against placement and owner changes. */
export class RuntimeProcesses {
  private readonly revisions = new WeakMap<RuntimeClient, { value: number }>();
  constructor(
    private readonly runtimes: RuntimeStore,
    private readonly connections: RuntimeConnections,
  ) {}

  hasSession(sessionId: string): boolean {
    return this.runtimes.usesExternalTerminals(sessionId) || !!this.runtimes.ownerOf(sessionId);
  }

  private revision(client: RuntimeClient): { value: number } {
    let revision = this.revisions.get(client);
    if (revision) return revision;
    revision = { value: 0 };
    const current = revision;
    const listen = (event: RuntimeEvent) => {
      if (
        event.t === 'native-lifecycle' ||
        event.t === 'native-collision' ||
        event.t === 'terminal-created' ||
        event.t === 'exit' ||
        event.t === 'agent-state'
      )
        current.value++;
    };
    client.on('event', listen);
    client.once('disconnected', () => {
      current.value++;
      client.off('event', listen);
    });
    this.revisions.set(client, current);
    return current;
  }

  async snapshot(sessionId: string): Promise<PortProcessSnapshot> {
    const unavailable: PortProcessSnapshot = {
      pids: [],
      hidden: new Set(),
      valid: () => false,
    };
    const owner = this.runtimes.ownerOf(sessionId);
    if (!owner || owner.active_session_id !== sessionId || !owner.active_segment_id)
      return unavailable;
    const client = this.connections.get(owner.runtime_id);
    if (!client) return unavailable;
    const revision = this.revision(client);
    const expected = revision.value;
    const valid = () => {
      const current = this.runtimes.get(owner.runtime_id);
      return (
        current?.active_session_id === sessionId &&
        current.active_segment_id === owner.active_segment_id &&
        ['prepared', 'running'].includes(current.state) &&
        this.connections.get(owner.runtime_id) === client &&
        revision.value === expected
      );
    };
    try {
      const response = await client.request({ t: 'inspect' });
      if (
        response.t !== 'state' ||
        response.state.state !== 'running' ||
        response.state.binding?.session_id !== sessionId ||
        response.state.binding.segment_id !== owner.active_segment_id ||
        !valid()
      )
        return unavailable;
      const state = response.state;
      return {
        pids: [
          ...new Set([
            ...state.terminals.flatMap((term) => (term.pid === null ? [] : [term.pid])),
            ...(state.agent?.sidecar_pids ?? []),
          ]),
        ],
        hidden: new Set(state.agent?.hidden_ports ?? []),
        valid,
      };
    } catch {
      // Unavailable ownership never falls through to historical PIDs or legacy PTYs.
      return unavailable;
    }
  }
}
