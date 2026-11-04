import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { RuntimeEvent, RuntimeResponse } from '@puddle/shared';
import { RuntimeTerminals } from '../../../src/runtime/controller/terminals.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import type { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { runtimeDatabase } from '../runtime-database.js';

import { RuntimeTerminalBuffers } from '../../../src/runtime/controller/terminals/buffers.js';

export function terminalViewFixture(buffers = new RuntimeTerminalBuffers()) {
  const f = runtimeDatabase();
  const generation = randomUUID();
  f.reconciler.applyPage(f.binding.runtime_id, {
    events: [
      {
        t: 'terminal-created',
        cursor: 1,
        terminal: { term: 'agent', generation, pid: 42, exit_code: null, cols: 80, rows: 24 },
      },
    ],
    through: 1,
    more: false,
    gap: false,
    journal: { cursor: 1, acknowledged: 0, lost_through: 0, persistence_pending: false },
  });
  let snapshot!: (response: RuntimeResponse) => void;
  const pending = new Promise<RuntimeResponse>((resolve) => {
    snapshot = resolve;
  });
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn((request: { t: string; data?: string }): Promise<RuntimeResponse> =>
      request.t === 'snapshot' ? pending : Promise.resolve({ t: 'ok', id: randomUUID() }),
    ),
  });
  const connections = Object.assign(new EventEmitter(), { get: () => client });
  const terminals = new RuntimeTerminals(
    f.home,
    f.runtimes,
    connections as unknown as RuntimeConnections,
    f.reconciler.observations,
    buffers,
  );
  connections.emit('connected', f.binding.runtime_id, client as unknown as RuntimeClient);
  let valid = true;
  const send = vi.fn();
  const reconnect = vi.fn();
  const view = terminals.open(f.session.id, 'agent', { valid: () => valid, send, reconnect });
  const output = (cursor: number, data: string) =>
    client.emit('event', {
      t: 'output',
      cursor,
      data,
      term: 'agent',
      generation,
      segment_id: f.binding.runtime_id,
    } satisfies RuntimeEvent);
  const finish = () =>
    snapshot({
      t: 'snapshot',
      id: randomUUID(),
      term: 'agent',
      generation,
      segment_id: f.binding.runtime_id,
      cursor: 5,
      data: 'snapshot-through-five',
    });
  const views = [view];
  const open = () => {
    const send = vi.fn();
    const reconnect = vi.fn();
    const view = terminals.open(f.session.id, 'agent', { valid: () => true, send, reconnect });
    views.push(view);
    return { view, send, reconnect };
  };
  return {
    ...f,
    buffers,
    terminals,
    open,
    generation,
    client,
    connections,
    view,
    send,
    reconnect,
    output,
    finish,
    revoke: () => {
      valid = false;
    },
    async close() {
      for (const view of views) view.dispose();
      await f.reconciler.close();
      f.db.close();
    },
  };
}
