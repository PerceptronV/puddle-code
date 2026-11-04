import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  clients,
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('freezes committed cursors while the owner continues, then catches up without replay', async () => {
  const f = runtimeDatabase();
  let hold: ReturnType<typeof f.reconciler.pause> | undefined;
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(client);
    await f.reconciler.attach(f.binding.runtime_id, client);
    const main = terminal(client.state);
    const input = (data: string) =>
      client.request({
        t: 'input',
        placement: placement(client),
        term: 'agent',
        generation: main.generation,
        source: 'human',
        data,
      });
    await input("stty -echo; counter=1; printf 'checkpoint-ready\\n'\n");
    await waitForSnapshot(client, main.generation, 'checkpoint-ready');
    hold = f.reconciler.pause();
    await hold.drain();
    const cursor = f.runtimes.get(f.binding.runtime_id)!.event_cursor;
    await input(
      'counter=$((counter+1)); printf \'\\033]0;paused-title\\007during-pause-%s\\n\' "$counter"\n',
    );
    await waitForSnapshot(client, main.generation, 'during-pause-2');
    const inspected = await client.request({ t: 'inspect' });
    if (inspected.t !== 'state') throw new Error('Owner omitted state');
    expect(inspected.state.journal.cursor).toBeGreaterThan(cursor);
    expect(terminal(inspected.state).pid).toBe(main.pid);
    await expect(f.reconciler.refresh(f.binding.runtime_id)).rejects.toThrow(/paused/);
    expect(f.reconciler.settled(f.binding.runtime_id)).toBe(false);
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(cursor);
    expect(f.sessions.get(f.session.id).osc_title).not.toBe('paused-title');
    hold.release();
    await vi.waitFor(() => expect(f.sessions.get(f.session.id).osc_title).toBe('paused-title'));
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBeGreaterThanOrEqual(
      inspected.state.journal.cursor,
    );
    await input('printf \'after-checkpoint-%s\\n\' "$counter"\n');
    await waitForSnapshot(client, main.generation, 'after-checkpoint-2');
  } finally {
    hold?.release();
    await f.reconciler.close();
    f.db.close();
  }
});

it('drains an in-flight event request without committing its late reply', async () => {
  const f = runtimeDatabase();
  type Reply = Awaited<ReturnType<RuntimeClient['request']>>;
  let reply!: (value: Reply) => void;
  const pending = new Promise<Reply>((resolve) => {
    reply = resolve;
  });
  const request = vi.fn(() => pending);
  const client = Object.assign(new EventEmitter(), { request }) as unknown as RuntimeClient;
  const page = {
    events: [
      {
        t: 'terminal-created' as const,
        cursor: 1,
        terminal: {
          term: 'agent',
          generation: randomUUID(),
          pid: 42,
          exit_code: null,
          cols: 80,
          rows: 24,
        },
      },
    ],
    through: 1,
    more: false,
    gap: false,
    journal: { cursor: 1, acknowledged: 0, lost_through: 0, persistence_pending: false },
  };
  const attached = f.reconciler.attach(f.binding.runtime_id, client);
  let hold: ReturnType<typeof f.reconciler.pause> | undefined;
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    hold = f.reconciler.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    reply({ t: 'events', id: randomUUID(), page });
    await attached;
    await drain;
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(f.binding.event_cursor);
    expect(f.reconciler.observations.get(f.binding.runtime_id)).toBeNull();
    expect(() => f.reconciler.applyPage(f.binding.runtime_id, page)).toThrow(/maintenance/);
    expect(await f.reconciler.retire('unknown-owner')).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    await f.reconciler.close();
    hold.release();
    expect(() => f.reconciler.pause()).toThrow(/maintenance/);
    expect(() => f.reconciler.applyPage(f.binding.runtime_id, page)).toThrow(/maintenance/);
  } finally {
    reply({ t: 'events', id: randomUUID(), page });
    await attached;
    await f.reconciler.close();
    hold?.release();
    f.db.close();
  }
});
