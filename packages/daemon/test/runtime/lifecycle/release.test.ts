import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, hostStageReceiptSchema } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { startUpdateWorker } from '../../../src/updates/worker/supervisor.js';
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
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';

it.runIf(!!process.env.PUDDLE_TEST_RUNTIME_RELEASE)(
  'runs the packaged owner and pinned native dependencies through controller replacement',
  async () => {
    let stage = resolve(process.env.PUDDLE_TEST_RUNTIME_RELEASE!);
    const f = prepare();
    const env = environment(f.home);
    const version = readFileSync(join(stage, 'VERSION'), 'utf8').trim();
    const archive = process.env.PUDDLE_TEST_RUNTIME_ARCHIVE;
    const install = async (component: 'daemon' | 'runtime' = 'daemon', force = false) => {
      const installer = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../scripts/install.sh',
      );
      const tarball = resolve(archive!);
      const selected = join(f.home, 'bin', component === 'daemon' ? 'current' : 'runtime-current');
      const previous = force ? realpathSync(selected) : undefined;
      const result = await promisify(execFile)(
        'sh',
        [
          installer,
          '--version',
          version,
          '--tarball',
          tarball,
          '--sums',
          `${tarball}.sha256`,
          '--no-supervisor',
          '--component',
          component,
          ...(force ? ['--stage-only'] : []),
        ],
        {
          env: { ...env, PUDDLE_HOME: f.home },
          timeout: 30_000,
        },
      );
      if (force) {
        expect(realpathSync(selected)).toBe(previous);
        const line = result.stdout
          .split('\n')
          .find((line) => line.startsWith('PUDDLE_HOST_STAGE '));
        const receipt = hostStageReceiptSchema.parse(
          JSON.parse(line!.slice('PUDDLE_HOST_STAGE '.length)),
        );
        expect(receipt.record.checksum_verified).toBe(true);
        if (component === 'runtime') {
          const store = new HostUpdateOperations(f.home);
          let operation = store.begin([{ component, version }]).operation;
          operation = store.staged(operation, receipt);
          operation = store.preflight(operation, digest('isolated packaged-owner update fixture'));
          operation = store.approve(operation, operation.preflight!);
          const release = realpathSync(join(f.home, 'bin', 'versions', receipt.record.generation));
          await startUpdateWorker(f.home, operation, {
            kind: 'launchd',
            releasePath: release,
            // Exercise the actual packaged worker; native supervisor lifetime has a separate gate.
            run: async () => {
              const output = await promisify(execFile)(
                join(release, 'bin/node'),
                [
                  join(release, 'daemon/host-update.mjs'),
                  '--home',
                  f.home,
                  '--operation',
                  operation.id,
                ],
                { env, timeout: 30_000 },
              );
              return { exitCode: 0, ...output };
            },
          });
          expect(store.read(operation.id)?.phase).toBe('complete');
          expect(store.read(operation.id)?.verification).toMatch(/^[a-f0-9]{64}$/);
          return realpathSync(selected);
        }
        await promisify(execFile)(
          'sh',
          [
            installer,
            '--component',
            component,
            '--version',
            version,
            '--activate-generation',
            receipt.record.generation,
            '--stage-digest',
            receipt.digest,
            '--no-supervisor',
          ],
          { env: { ...env, PUDDLE_HOME: f.home }, timeout: 30_000 },
        );
      }
      return realpathSync(selected);
    };
    if (archive) {
      stage = await install();
      expect(await install('runtime')).toBe(stage);
      expect(resolveInstalledRuntimeRelease(f.home).releasePath).toBe(stage);
    }
    const before = readdirSync(f.home).sort();
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

    if (archive) {
      const originalBundle = readFileSync(join(stage, 'daemon', 'puddler.mjs'));
      const replacement = await install('daemon', true);
      expect(replacement).not.toBe(stage);
      expect(resolveInstalledRuntimeRelease(f.home).releasePath).toBe(stage);
      const newDefault = await install('runtime', true);
      expect(newDefault).not.toBe(stage);
      expect(resolveInstalledRuntimeRelease(f.home)).toMatchObject({
        releasePath: newDefault,
        nodePath: join(newDefault, 'bin', 'node'),
        entryPath: join(newDefault, 'daemon', 'puddler.mjs'),
      });
      expect(realpathSync(join(f.home, 'bin', 'current'))).toBe(replacement);
      expect(readFileSync(join(stage, 'daemon', 'puddler.mjs'))).toEqual(originalBundle);
      expect(child.exitCode).toBeNull();
    }

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
