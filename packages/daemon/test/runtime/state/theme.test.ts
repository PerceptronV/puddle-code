import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient, RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeReconciler } from '../../../src/runtime/controller/reconcile.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';
import { placement } from '../../helpers/runtime-placement.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import {
  clients,
  controllers,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
} from '../../helpers/runtime-fixture.js';

// A real PTY child repeatedly queries colours and records only the OSC replies.
// There is no browser or installed provider to answer on the owner's behalf.
const probe = String.raw`
const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdin.resume();
let carry = '', count = 0;
const colours = {};
process.stdin.on('data', chunk => {
  carry += chunk.toString();
  const pattern = /\x1b\](10|11);(rgb:[a-f0-9/]+)\x1b\\/g;
  let match, through = 0;
  while ((match = pattern.exec(carry))) {
    colours[match[1]] = match[2]; count++; through = pattern.lastIndex;
  }
  carry = carry.slice(through).slice(-256);
  fs.writeFileSync(process.argv[1], JSON.stringify({ count, colours }), { mode: 0o600 });
});

const query = () => process.stdout.write('\x1b]10;?\x07\x1b]11;?\x1b\\');
query(); setInterval(query, 100);
`;

it('answers colour queries from launch through controller loss, theme switches and extra shells', async () => {
  const f = prepare();
  const report = join(f.home, 'colours.json');
  const shellReport = join(f.home, 'shell-colours.json');
  const firstColours = { fg: '#123456', bg: '#abcdef' };
  const nextColours = { fg: '#fedcba', bg: '#654321' };
  f.launch.theme = firstColours;
  f.launch.main = { ...f.launch.main, file: process.execPath, args: ['-e', probe, report] };
  atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
  const owner = launchOwner(f.home, f.launch.identity.runtime_id);
  await waitForOwner(owner, f.directory);
  const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
  clients.push(client);
  const original = terminal(client.state);
  const read = (path = report) => {
    try {
      return readRuntimeJson(path) as { count: number; colours: Record<string, string> };
    } catch {
      return null;
    }
  };
  await waitFor(() => read()?.colours['11'] === 'rgb:abab/cdcd/efef');
  expect(read()?.colours['10']).toBe('rgb:1212/3434/5656');
  const count = read()!.count;
  client.close();
  f.controller.release();
  await waitFor(() => (read()?.count ?? 0) >= count + 4);
  const controller = acquireRuntimeController(f.home);
  controllers.push(controller);
  const next = await RuntimeClient.open(f.home, f.launch, controller.record);
  clients.push(next);
  expect(next.state?.theme).toEqual(firstColours);
  expect(terminal(next.state).pid).toBe(original.pid);
  await expect(
    next.request({
      t: 'theme',
      placement: { ...placement(next), session_id: randomUUID() },
      colours: nextColours,
    }),
  ).rejects.toMatchObject({ code: 'stale_placement' });
  await next.request({ t: 'inspect' });
  expect(next.state?.theme).toEqual(firstColours);
  await next.request({ t: 'theme', placement: placement(next), colours: nextColours });
  await waitFor(() => read()?.colours['11'] === 'rgb:6565/4343/2121');
  expect(read()?.colours['10']).toBe('rgb:fefe/dcdc/baba');
  await next.request({
    t: 'spawn-shell',
    placement: placement(next),
    term: 'shell-1',
    command: { ...f.launch.main, args: ['-e', probe, shellReport] },
  });
  await waitFor(() => read(shellReport)?.colours['11'] === 'rgb:6565/4343/2121');
  expect(read(shellReport)?.colours['10']).toBe('rgb:fefe/dcdc/baba');
  await next.request({ t: 'inspect' });
  expect(terminal(next.state).pid).toBe(original.pid);
});

it.each([false, true])(
  'converges reported colours after lost acknowledgements and detects older owners (older=%s)',
  async (older) => {
    const f = runtimeDatabase();
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    f.controller.release();
    await f.reconciler.close();
    let colours = { fg: '#123456', bg: '#abcdef' };
    const reconciler = new RuntimeReconciler({ ...f, theme: () => colours });
    let changes = 0;
    const connections = new RuntimeConnections(f.home, f.runtimes, {
      connected: async (id, client) => {
        const request = client.request.bind(client);
        vi.spyOn(client, 'request').mockImplementation(async (value) => {
          const response = await request(value);
          if (older && value.t === 'inspect' && response.t === 'state') delete response.state.theme;
          if (value.t === 'theme') {
            changes++;
            if (changes === 1) throw new RuntimeConnectionLost(); // Applied; discard only its reply.
          }
          return response;
        });
        await reconciler.attach(id, client);
      },
    });
    try {
      await connections.connect();
      await reconciler.refresh(f.binding.runtime_id);
      expect(reconciler.pendingIds()).toEqual([]);
      expect(changes).toBe(older ? 0 : 1);
      colours = { fg: '#fedcba', bg: '#654321' };
      reconciler.refreshThemes();
      if (older) {
        await reconciler.refresh(f.binding.runtime_id);
        expect(changes).toBe(0);
      } else {
        await waitFor(() => connections.get(f.binding.runtime_id)?.state?.theme?.bg === colours.bg);
        expect(changes).toBe(2);
      }
    } finally {
      await reconciler.close();
      await connections.close();
      f.db.close();
    }
  },
);
