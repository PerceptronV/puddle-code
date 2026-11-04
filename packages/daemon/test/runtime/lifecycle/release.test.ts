import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';
import {
  children,
  clients,
  controllers,
  environment,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it.runIf(!!process.env.PUDDLE_TEST_RUNTIME_RELEASE)(
  'runs the packaged owner and pinned native dependencies through controller replacement',
  async () => {
    const stage = resolve(process.env.PUDDLE_TEST_RUNTIME_RELEASE!);
    const f = prepare();
    const env = environment(f.home);
    const before = readdirSync(f.home).sort();
    const version = readFileSync(join(stage, 'VERSION'), 'utf8').trim();
    const protocol = `${RUNTIME_PROTOCOL_VERSION.major}.${RUNTIME_PROTOCOL_VERSION.minor}`;
    expect(readFileSync(join(stage, 'RUNTIME_PROTOCOL'), 'utf8').trim()).toBe(protocol);
    expect(
      execFileSync(join(stage, 'puddler'), ['--version'], {
        env,
        encoding: 'utf8',
        timeout: 5000,
      }).trim(),
    ).toBe(`puddler ${version} (runtime protocol ${protocol})`);
    expect(readdirSync(f.home).sort()).toEqual(before);

    const child = spawn(
      join(stage, 'puddler'),
      ['--home', f.home, '--runtime', f.launch.identity.runtime_id],
      {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    children.push(child);
    let errors = '';
    child.stderr!.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-8192);
    });
    await waitForOwner({ child, errors: () => errors }, f.directory);
    const first = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(first);
    expect(first.state?.build).toBe(version);
    const main = terminal(first.state);
    await first.request({
      t: 'input',
      placement: placement(first),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'stty -echo; preserved=archive; printf \'before-%s\\n\' "$preserved"\n',
    });
    await waitForSnapshot(first, main.generation, 'before-archive');
    first.close();
    f.controller.release();

    const controller = acquireRuntimeController(f.home);
    controllers.push(controller);
    const next = await RuntimeClient.open(f.home, f.launch, controller.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(main.pid);
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'after-%s\\n\' "$preserved"\n',
    });
    await waitForSnapshot(next, main.generation, 'after-archive');
    const exited = once(child, 'exit');
    await next.request({ t: 'stop', placement: placement(next) });
    expect((await exited)[0]).toBe(0);
  },
);
