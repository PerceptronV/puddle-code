import { placement } from '../helpers/runtime-placement.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeStateSchema, type RuntimeState } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/transport/client.js';
import {
  connectRuntimeOwner,
  retireMissingRuntime,
} from '../../src/runtime/ownership/discovery.js';
import { acquireHostClaim, HostClaimBusy } from '../../src/security/claims.js';
import { readRuntimeJournal } from '../../src/runtime/state/journal.js';
import {
  acquireRuntimeController,
  acquireRuntimeControllerWhenAvailable,
  readRuntimeJson,
  runtimeDirectory,
} from '../../src/runtime/ownership/storage.js';
import {
  setup,
  terminal,
  clients,
  controllers,
  launchOwner,
  waitForSnapshot,
  children,
  environment,
  bundleDir,
} from '../helpers/runtime-fixture.js';

describe('isolated runtime host', () => {
  it('retains the same shell process and in-memory variables when its controller is replaced', async () => {
    const { home, launch, controller, client } = await setup();
    const original = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'stty -echo; state=survived; printf \'before-%s\\n\' "$state"\n',
    });
    await waitForSnapshot(client, original.generation, 'before-survived');
    controller.release();
    const replacement = await acquireRuntimeControllerWhenAvailable(home);
    controllers.push(replacement);
    // The previous TCP/Unix stream is still connected but its epoch is fenced.
    await expect(
      client.request({
        placement: placement(client),
        t: 'input',
        term: 'agent',
        generation: original.generation,
        source: 'human',
        data: 'state=lost\n',
      }),
    ).rejects.toMatchObject({ code: 'fenced' });
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state)).toEqual(original);
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'printf \'after-%s\\n\' "$state"\n',
    });
    await waitForSnapshot(next, original.generation, 'after-survived');
  });

  it('keeps draining output without a viewer and rejects stale terminal input', async () => {
    const { home, launch, controller, client } = await setup();
    const original = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: "stty -echo; sleep 0.1; printf 'unattended-output\\n'\n",
    });
    client.close();
    const next = await RuntimeClient.open(home, launch, controller.record);
    clients.push(next);
    await waitForSnapshot(next, original.generation, 'unattended-output');
    await expect(
      next.request({
        placement: placement(next),
        t: 'input',
        term: 'agent',
        generation: randomUUID(),
        source: 'human',
        data: 'exit\n',
      }),
    ).rejects.toMatchObject({ code: 'stale_terminal' });
    const state = await next.request({ t: 'inspect' });
    expect(state.t).toBe('state');
    expect(terminal(next.state).pid).toBe(original.pid);
  });

  it('does not consume the launch twice, including after a runtime exits', async () => {
    const { home, launch, client, owner, directory } = await setup();
    const exited = once(owner.child, 'exit');
    await client.request({ placement: placement(client), t: 'stop' });
    await exited;
    const final = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
    expect(final.state).toBe('exited');
    const journal = readRuntimeJournal(directory, launch.identity);
    expect(journal.events.map((event) => event.t)).toEqual(['terminal-created', 'exit']);
    expect(final.journal.persistence_pending).toBe(false);
    const retry = launchOwner(home, launch.identity.runtime_id);
    const [code] = await once(retry.child, 'exit');
    expect(code).not.toBe(0);
    expect(retry.errors()).toContain('EEXIST');
    expect(readRuntimeJson(join(directory, 'state.json'))).toEqual(final);
    expect(readRuntimeJournal(directory, launch.identity)).toEqual(journal);
  });

  it('replays an extra shell exit after disconnection and acknowledges only offered events', async () => {
    const { home, launch, controller, client } = await setup();
    await expect(client.request({ t: 'ack-events', through: 1 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await client.request({
      placement: placement(client),
      t: 'spawn-shell',
      term: 'shell-1',
      command: { ...launch.main, args: ['-c', 'sleep 0.1; exit 7'] },
    });
    client.close();
    const next = await RuntimeClient.open(home, launch, controller.record);
    clients.push(next);
    const deadline = Date.now() + 10_000;
    let through: number;
    while (true) {
      const response = await next.request({ t: 'events', after: 0 });
      if (response.t !== 'events') throw new Error('Expected event history');
      expect(response.page.gap).toBe(false);
      if (response.page.events.some((event) => event.t === 'exit' && event.term === 'shell-1')) {
        expect(response.page.events.map((event) => event.t)).toEqual([
          'terminal-created',
          'terminal-created',
          'exit',
        ]);
        expect(response.page.events.at(-1)).toMatchObject({ exit_code: 7 });
        expect(response.page.journal.persistence_pending).toBe(false);
        through = response.page.through;
        break;
      }
      if (Date.now() > deadline) throw new Error('Shell exit was not retained');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // A replacement connection must obtain its own replay boundary. Merely
    // knowing the cursor from an earlier controller does not authorise pruning.
    next.close();
    const replacement = await RuntimeClient.open(home, launch, controller.record);
    clients.push(replacement);
    await expect(replacement.request({ t: 'ack-events', through })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const replay = await replacement.request({ t: 'events', after: 0 });
    expect(replay.t).toBe('events');
    await replacement.request({ t: 'ack-events', through });
    await replacement.request({ t: 'ack-events', through });
    const committed = await replacement.request({ t: 'events', after: through });
    expect(committed).toMatchObject({ t: 'events', page: { events: [], gap: false } });
    const stale = await replacement.request({ t: 'events', after: 0 });
    expect(stale).toMatchObject({ t: 'events', page: { gap: true } });
    expect(terminal(replacement.state).pid).toBe(terminal(client.state).pid);
  });

  it('refuses to retire a live owner and imports its final state after exit', async () => {
    const { home, launch, client, owner } = await setup();
    let applied: RuntimeState | null = null;
    const retired = retireMissingRuntime(home, launch.identity, (state) => {
      applied = state;
    });
    expect(retired).toBe('owned');
    expect(applied).toBeNull();
    const exited = once(owner.child, 'exit');
    await client.request({ placement: placement(client), t: 'stop' });
    await exited;
    expect(
      retireMissingRuntime(home, launch.identity, (state, journal) => {
        applied = state;
        expect(journal?.events.at(-1)).toMatchObject({ t: 'exit', term: 'agent' });
      }),
    ).toBe('retired');
    expect(applied).toMatchObject({ state: 'exited', identity: launch.identity });
    const late = launchOwner(home, launch.identity.runtime_id);
    const [code] = await once(late.child, 'exit');
    expect(code).not.toBe(0);
    expect(late.errors()).toContain('Runtime launch was retired');
  });

  it('fences a dispatched launch that has not started before confirmed absence is committed', async () => {
    const { home, launch, directory } = await setup();
    const identity = {
      ...launch.identity,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
    };
    const pending = runtimeDirectory(home, identity.runtime_id);
    atomicPrivateJson(join(pending, 'launch.json'), { ...launch, identity });
    let calls = 0;
    expect(() =>
      retireMissingRuntime(home, identity, () => {
        throw new Error('Database unavailable');
      }),
    ).toThrow('Database unavailable');
    expect(
      retireMissingRuntime(home, identity, (state) => {
        expect(state).toBeNull();
        calls++;
      }),
    ).toBe('retired');
    const late = launchOwner(home, identity.runtime_id);
    const [code] = await once(late.child, 'exit');
    expect(code).not.toBe(0);
    expect(late.errors()).toContain('Runtime launch was retired');
    expect(calls).toBe(1);
    expect(runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json'))).state).toBe(
      'running',
    );
  });

  it('adopts only a manifest matching every immutable ownership field', async () => {
    const { home, launch, controller } = await setup();
    await expect(
      connectRuntimeOwner(
        home,
        { ...launch.identity, project_id: '3333333333' },
        controller.record,
      ),
    ).rejects.toThrow(/identity changed/);
    const next = await connectRuntimeOwner(home, launch.identity, controller.record);
    clients.push(next);
    expect(next.state?.identity).toEqual(launch.identity);
  });

  it('releases a crashed controller claim without restarting its independent runtime', async () => {
    const { home, launch, controller, client } = await setup();
    const original = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'stty -echo; state=retained; printf \'ready-%s\\n\' "$state"\n',
    });
    await waitForSnapshot(client, original.generation, 'ready-retained');
    client.close();
    controller.release();
    const peer = spawn(
      process.execPath,
      [join(bundleDir, 'controller.mjs'), home, launch.identity.runtime_id],
      {
        env: environment(home),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(peer);
    const [ready] = await Promise.race([
      once(peer, 'message'),
      once(peer, 'exit').then(() => {
        throw new Error('Controller fixture exited before adoption');
      }),
    ]);
    expect(ready.t).toBe('ready');
    expect(() => acquireRuntimeController(home)).toThrow(HostClaimBusy);
    expect(() => acquireHostClaim(home, `runtime:${launch.identity.runtime_id}`)).toThrow(
      HostClaimBusy,
    );
    const exited = once(peer, 'exit');
    peer.kill('SIGKILL');
    await exited;
    const replacement = await acquireRuntimeControllerWhenAvailable(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(original.pid);
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: 'printf \'crash-%s\\n\' "$state"\n',
    });
    await waitForSnapshot(next, original.generation, 'crash-retained');
  });

  it('rejects wrong runtime identity and secret', async () => {
    const { home, launch, controller } = await setup();
    await expect(
      RuntimeClient.open(home, { ...launch, secret: '0'.repeat(64) }, controller.record),
    ).rejects.toMatchObject({ code: 'unauthorised' });
    await expect(
      RuntimeClient.open(
        home,
        { ...launch, identity: { ...launch.identity, incarnation: randomUUID() } },
        controller.record,
      ),
    ).rejects.toMatchObject({ code: 'unauthorised' });
  });
});
