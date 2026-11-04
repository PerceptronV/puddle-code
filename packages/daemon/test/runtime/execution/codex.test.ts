import { placement } from '../../helpers/runtime-placement.js';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';
import {
  bundleDir,
  clients,
  controllers,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';

describe('runtime-owned Codex adapter', () => {
  it('keeps its real proxy and fake app-server through controller replacement, then reaps the sidecar', async () => {
    const { home, launch, directory, controller } = prepare('interactive');
    const bin = join(home, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(
      join(bin, 'codex'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bundleDir, 'fake-codex.mjs'))} "$@"\n`,
      { mode: 0o700 },
    );
    const path = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    launch.provider!.id = 'codex';
    launch.main.env['PATH'] = path;
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const owner = launchOwner(home, launch.identity.runtime_id, 'puddler.mjs', path);
    await waitForOwner(owner, directory);
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const term = terminal(client.state);
    await waitForSnapshot(client, term.generation, 'bound:native-codex-fixture');
    const input = {
      placement: placement(client),
      t: 'input' as const,
      term: 'agent',
      generation: term.generation,
      source: 'human' as const,
      data: 'tick\n',
    };
    await client.request(input);
    await waitForSnapshot(client, term.generation, 'count:1');
    const pid = client.state!.agent!.sidecar_pids[0]!;
    client.close();
    controller.release();
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(term.pid);
    expect(next.state!.agent).toMatchObject({
      native_sync: 'full',
      sidecar_pids: [pid],
      agent_session_ref: 'native-codex-fixture',
    });
    await next.request(input);
    await waitForSnapshot(next, term.generation, `count:2 sidecar:${pid}`);
    const exited = once(owner.child, 'exit');
    await next.request({ placement: placement(next), t: 'stop' });
    await exited;
    // The fixture ignores SIGTERM, so this also proves disposal waits for its
    // bounded SIGKILL fallback before the owner releases its lifetime claim.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
