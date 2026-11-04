import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../src/runtime/ownership/storage.js';
import { placement } from '../../helpers/runtime-placement.js';
import {
  clients,
  controllers,
  setup,
  terminal,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';

it.each(['journal', 'state'] as const)(
  'keeps the same shell and human input across controller replacement while its %s slot is uncertain',
  async (kind) => {
    const { home, launch, directory, controller, client } = await setup();
    const main = terminal(client.state);
    // Force the initial journal save to finish before installing an uncertain slot.
    const initial = await client.request({ t: 'events', after: 0 });
    expect(initial.t).toBe('events');
    const slot = join(directory, `.${kind}-0.tmp`);
    const previousState = readFileSync(join(directory, 'state.json'), 'utf8');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        writeFileSync(slot, 'uncertain-fixture-write', { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'stty -echo; retained=alive; printf \'before-%s\\n\' "$retained"\n',
    });
    await waitForSnapshot(client, main.generation, 'before-alive');
    // Terminal creation creates an essential event; failure to save it cannot stop the PTY.
    await client.request({
      placement: placement(client),
      t: 'spawn-shell',
      term: 'shell-1',
      command: launch.main,
    });
    const pending = await client.request({ t: 'events', after: 0 });
    if (kind === 'journal')
      expect(pending).toMatchObject({
        t: 'events',
        page: { journal: { persistence_pending: true } },
      });
    client.close();
    controller.release();
    const replacement = await acquireRuntimeControllerWhenAvailable(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(next.state?.persistence_pending).toBe(true);
    expect(terminal(next.state)).toMatchObject({ pid: main.pid, generation: main.generation });
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'after-%s\\n\' "$retained"\n',
    });
    await waitForSnapshot(next, main.generation, 'after-alive');
    expect(readFileSync(slot, 'utf8')).toBe('uncertain-fixture-write');
    if (kind === 'state')
      expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe(previousState);
    expect(readdirSync(directory).filter((name) => name.startsWith(`.${kind}-`))).toEqual([
      `.${kind}-0.tmp`,
    ]);
  },
);
