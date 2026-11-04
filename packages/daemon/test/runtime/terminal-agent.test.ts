import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { sessionSchema, type NotificationContent } from '@puddle/shared';
import { RuntimeClient } from '../../src/runtime/client.js';
import { readRuntimeJson } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { clients, launchOwner, terminal, waitForOwner } from '../helpers/runtime-fixture.js';
import { waitFor } from '../helpers/daemon-fixtures.js';
import { placement } from '../helpers/runtime-placement.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

it('keeps terminal agent recognition and busy-to-idle evidence in the owner across daemon replacement', async () => {
  const f = runtimeDatabase();
  const deliveries: Array<{ id: string; content: NotificationContent }> = [];
  const sink = await listenPrivate(ipcPath(f.home, `remote-${f.profile.id}`), (socket) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (!text.includes('\n')) return;
      deliveries.push(JSON.parse(text) as (typeof deliveries)[number]);
      socket.end('{}\n');
    });
  });
  const script = join(f.home, 'runtime-terminal-agent.cjs');
  const command = join(f.home, 'main-command.json');
  const extraCommand = join(f.home, 'extra-command.json');
  writeFileSync(
    script,
    `
const fs = require('node:fs');
const file = process.argv[2];
fs.writeFileSync(file + '.pid', JSON.stringify({ pid: process.pid }), { mode: 0o600 });
process.stdout.write('RUNTIME_IDLE\\n');
let seen = 0;
setInterval(() => {
  let next;
  try { next = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (next.seq <= seen) return;
  seen = next.seq;
  fs.writeFileSync(file + '.ack', JSON.stringify({ seq: seen }), { mode: 0o600 });
  if (next.exit) process.exit(0);
  process.stdout.write(next.data + '\\n');
}, 50);
`,
    { mode: 0o600 },
  );
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  const start = async () => {
    rmSync(join(f.home, 'test-daemon-ready.json'), { force: true });
    daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
    await waitFor(() => {
      if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
      try {
        ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
        return true;
      } catch {
        return false;
      }
    });
  };
  const stop = async () => {
    const exited = once(daemon!.child, 'exit');
    daemon!.child.kill('SIGTERM');
    expect((await exited)[0]).toBe(0);
  };
  const inspect = async () => {
    const response = await fetch(`http://127.0.0.1:${ready!.port}/api/sessions/${f.session.id}`, {
      headers: { authorization: `Bearer ${ready!.token}` },
    });
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json());
  };
  const output = async (seq: number, data: string) => {
    writeFileSync(command, JSON.stringify({ seq, data }));
    await waitFor(() => {
      try {
        return (readRuntimeJson(`${command}.ack`) as { seq: number }).seq === seq;
      } catch {
        return false;
      }
    });
  };
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id, 'provider-owner.mjs');
    await waitForOwner(owner, f.directory);
    const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(client);
    const root = terminal(client.state);
    await client.request({
      t: 'spawn-shell',
      placement: placement(client),
      term: 'shell-1',
      command: { ...f.launch.main, file: process.execPath, args: [script, extraCommand] },
    });
    await client.request({
      t: 'input',
      placement: placement(client),
      term: 'agent',
      generation: root.generation,
      source: 'human',
      data: `stty -echo; ${quote(process.execPath)} ${quote(script)} ${quote(command)}\n`,
    });
    const deadline = Date.now() + 10_000;
    while (client.state?.terminal_agent !== 'runtime-terminal-test') {
      if (Date.now() > deadline) throw new Error('Owner did not recognise its foreground fixture');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.request({ t: 'inspect' });
    }
    const child = readRuntimeJson(`${command}.pid`) as { pid: number };
    const extra = readRuntimeJson(`${extraCommand}.pid`) as { pid: number };
    client.close();
    f.controller.release();
    await start();
    expect(await inspect()).toMatchObject({
      kind: 'terminal',
      status: 'running',
      detected_agent_type: 'runtime-terminal-test',
      agent_type: null,
      agent_session_ref: null,
    });
    expect(deliveries).toEqual([]); // Initial idle is never a completed turn.
    await output(1, 'RUNTIME_BUSY');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await output(2, 'RUNTIME_IDLE');
    await waitFor(() => deliveries.length === 1);
    await output(3, 'RUNTIME_BUSY');
    await waitFor(
      () =>
        (
          f.db.prepare('SELECT attention FROM runtime_attention').get() as
            { attention: string | null } | undefined
        )?.attention === null,
    );
    await stop();
    await output(4, 'RUNTIME_IDLE');
    await start();
    await waitFor(() => deliveries.length === 2);
    expect(new Set(deliveries.map((event) => event.id)).size).toBe(2);
    expect(deliveries.every((event) => event.content.session === f.session.id)).toBe(true);
    expect(await inspect()).toMatchObject({
      kind: 'terminal',
      status: 'running',
      detected_agent_type: 'runtime-terminal-test',
      agent_session_ref: null,
    });
    expect(f.reconciler.observations.get(f.binding.runtime_id)?.terminals[0]?.pid).toBe(root.pid);
    process.kill(child.pid, 0);
    writeFileSync(command, JSON.stringify({ seq: 5, exit: true }));
    await waitFor(() => deliveries.length === 3);
    expect(await inspect()).toMatchObject({
      kind: 'terminal',
      status: 'running',
      detected_agent_type: null,
      agent_type: null,
      agent_session_ref: null,
    });
    process.kill(extra.pid, 0); // A recognised agent in the extra tab cannot own the main hint.
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM agent_conversations').get()).toEqual({
      count: 0,
    });
    const killed = await fetch(
      `http://127.0.0.1:${ready!.port}/api/sessions/${f.session.id}/kill`,
      { method: 'POST', headers: { authorization: `Bearer ${ready!.token}` } },
    );
    expect(killed.status).toBe(200);
    await killed.arrayBuffer();
    await stop();
    expect(deliveries).toHaveLength(3);
  } finally {
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) await stop();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await f.reconciler.close();
    f.db.close();
  }
});
