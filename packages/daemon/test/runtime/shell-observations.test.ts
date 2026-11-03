import { placement } from '../helpers/runtime-placement.js';
import { once } from 'node:events';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/client.js';
import { acquireRuntimeController, readRuntimeJson } from '../../src/runtime/storage.js';
import { readRuntimeJournal } from '../../src/runtime/journal.js';
import {
  clients,
  controllers,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';

const b64 = (value: string) => Buffer.from(value).toString('base64');
const set = (name: string, value: string) => `\\033]7733;set;${b64(name)};${b64(value)}\\007`;
const cwd = (path: string) => `\\033]7733;cwd;${b64(path)}\\007`;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

describe('shell observation continuity', () => {
  it('recovers private deltas and directories after controller loss without leaking values to terminal output', async () => {
    const { home, launch, controller, directory } = prepare();
    launch.capture_env = { enabled: true, values: { EXISTING: 'seed' } };
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const owner = launchOwner(home, launch.identity.runtime_id);
    await waitForOwner(owner, directory);
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const original = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: "stty -echo; printf 'echo-%s\\n' disabled\n",
    });
    await waitForSnapshot(client, original.generation, 'echo-disabled');

    const secret = 'private-runtime-value-🚀';
    const script = join(home, 'observations.sh');
    writeFileSync(
      script,
      [
        'sleep 0.1',
        `printf '${set('TOKEN', 'old-private-value')}'`,
        // Split the introducer across writes to exercise the owner's OSC filter.
        "printf '\\033]77'; sleep 0.02",
        `printf '33;set;${b64('TOKEN')};${b64(secret)}\\007'`,
        `printf '${set('EMPTY', '')}'`,
        `printf '\\033]7733;unset;${b64('EXISTING')}\\007'`,
        `printf '${set('PUDDLE_AGENT_HELPER_DIR', 'untrusted-control-path')}'`,
        `printf '${cwd(join(home, 'nested'))}'`,
        "printf 'reports-finished\\n'",
      ].join('\n'),
      { mode: 0o600 },
    );
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: original.generation,
      source: 'human',
      data: `/bin/sh ${quote(script)}\n`,
    });
    client.close();
    controller.release();
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    const snapshot = await waitForSnapshot(next, original.generation, 'reports-finished');
    expect(snapshot).not.toContain(secret);
    expect(snapshot).not.toContain(b64(secret));
    await next.request({ t: 'inspect' });
    expect(terminal(next.state).pid).toBe(original.pid);
    expect(next.state?.environment).toEqual({ enabled: true, count: 2 });
    expect(JSON.stringify(next.state)).not.toContain(secret);
    const replay = await next.request({ t: 'events', after: 0 });
    if (replay.t !== 'events') throw new Error('Missing private journal');
    expect(replay.page.gap).toBe(false);
    const changes = replay.page.events.filter((e) => e.t === 'env-delta');
    expect(changes.map((e) => e.delta)).toEqual([
      { op: 'set', name: 'TOKEN', value: secret },
      { op: 'set', name: 'EMPTY', value: '' },
      { op: 'unset', name: 'EXISTING' },
    ]);
    expect(replay.page.events).toContainEqual(
      expect.objectContaining({
        t: 'cwd',
        cwd: join(home, 'nested'),
        generation: original.generation,
      }),
    );
    expect(statSync(join(directory, 'events.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(readRuntimeJson(join(directory, 'state.json')))).not.toContain(secret);

    // The daemon has not committed/acknowledged these reports. The owner must
    // already supply their current values to a newly opened shell.
    await next.request({
      placement: placement(next),
      t: 'spawn-shell',
      term: 'shell-1',
      command: {
        ...launch.main,
        args: [
          '-c',
          '[ "$TOKEN" = "$EXPECTED" ] && [ "${EXISTING+x}" != x ] && [ "${EMPTY+x}" = x ] && printf "new-shell-current\\n"',
        ],
        env: { ...launch.main.env, EXPECTED: secret },
      },
    });
    await next.request({ t: 'inspect' });
    const shell = next.state!.terminals.find((t) => t.term === 'shell-1')!;
    const deadline = Date.now() + 5000;
    while (true) {
      const snapshot = await next.request({
        t: 'snapshot',
        term: 'shell-1',
        generation: shell.generation,
      });
      if (snapshot.t === 'snapshot' && snapshot.data.includes('new-shell-current')) break;
      if (Date.now() >= deadline)
        throw new Error('New shell did not receive the current captured environment');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const exited = once(owner.child, 'exit');
    await next.request({ placement: placement(next), t: 'stop' });
    await exited;
    expect(readRuntimeJournal(directory, launch.identity).events).toContainEqual(
      expect.objectContaining({
        t: 'env-delta',
        delta: { op: 'set', name: 'TOKEN', value: secret },
      }),
    );
    for (const file of ['logs', 'screens', 'segments'].flatMap((root) =>
      readdirSync(join(directory, root), {
        recursive: true,
        withFileTypes: true,
      }),
    )) {
      if (!file.isFile()) continue;
      const text = readFileSync(join(file.parentPath, file.name), 'utf8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain(b64(secret));
      expect(text).not.toContain('old-private-value');
    }
  });

  it('retains capture and purge decisions while ignoring reports received with capture disabled', async () => {
    const { home, launch, controller, directory } = prepare();
    launch.capture_env = { enabled: true, values: { PERSISTED: 'seed' } };
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const owner = launchOwner(home, launch.identity.runtime_id);
    await waitForOwner(owner, directory);
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const term = terminal(client.state);
    await client.request({
      placement: placement(client),
      t: 'input',
      term: 'agent',
      generation: term.generation,
      source: 'human',
      data: "stty -echo; printf 'echo-%s\\n' disabled\n",
    });
    await waitForSnapshot(client, term.generation, 'echo-disabled');
    const report = async (marker: string) => {
      await client.request({
        placement: placement(client),
        t: 'input',
        term: 'agent',
        generation: term.generation,
        source: 'human',
        data: `stty -echo; printf '${set('NEW', 'value')}${cwd(home)}${marker}\\n'\n`,
      });
      await waitForSnapshot(client, term.generation, marker);
    };
    await client.request({ placement: placement(client), t: 'capture-env', enabled: false });
    await report('disabled-observation');
    await client.request({ t: 'inspect' });
    expect(client.state?.environment).toEqual({ enabled: false, count: 1 });
    await client.request({ placement: placement(client), t: 'clear-env' });
    await client.request({ placement: placement(client), t: 'capture-env', enabled: true });
    await report('enabled-observation');
    await client.request({ t: 'inspect' });
    expect(client.state?.environment).toEqual({ enabled: true, count: 1 });
    const replay = await client.request({ t: 'events', after: 0 });
    if (replay.t !== 'events') throw new Error('Missing private journal');
    expect(replay.page.events.filter((e) => e.t === 'env-delta')).toHaveLength(1);
    expect(replay.page.events.filter((e) => e.t === 'cwd')).toHaveLength(2);
    expect(replay.page.events.filter((e) => e.t === 'capture-env' || e.t === 'clear-env')).toEqual([
      expect.objectContaining({ t: 'capture-env', enabled: false }),
      expect.objectContaining({ t: 'clear-env' }),
      expect.objectContaining({ t: 'capture-env', enabled: true }),
    ]);
  });
});
