import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  hostStageReceiptSchema,
  hostReleaseCapabilities,
  hostUpdateWorkerLifetimeSchema,
  type HostUpdateWorker,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import {
  startUpdateWorker,
  readUpdateWorker,
  updateWorkerDirectory,
} from '../../../src/updates/worker/supervisor.js';
import {
  requireEndedUpdateWorker,
  requireEndedUpdateProcessGroup,
} from '../../../src/updates/worker/lifetime.js';
import { runCompilationCommand } from '../../../src/compilation/process.js';
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
  retainRuntimeHome,
} from '../../helpers/runtime-fixture.js';
import { continuitySupervisor } from '../../helpers/update-continuity/release.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';
import { placement } from '../../helpers/runtime-placement.js';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';

async function cleanupPackagedWorker(
  home: string,
  env: NodeJS.ProcessEnv,
  worker: HostUpdateWorker,
  ended: boolean,
) {
  try {
    expect(worker.kind).toBe('systemd');
    expect(worker.name).toBe(
      `puddle-update-${digest(realpathSync(home)).slice(0, 8)}-${worker.operation_id}.service`,
    );
    if (!ended) {
      const stopped = await runCompilationCommand({
        file: join(home, 'test-services/systemctl'),
        args: ['--user', 'stop', worker.name],
        cwd: home,
        env,
        timeoutMs: 30_000,
        maxOutputBytes: 8192,
      });
      expect(stopped.exitCode, stopped.stderr).toBe(0);
    }
    const pid = Number(readFileSync(join(home, 'test-services', `${worker.name}.pid`), 'utf8'));
    await waitFor(() => {
      try {
        requireEndedUpdateProcessGroup(pid);
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    retainRuntimeHome(home);
    throw new Error(`Packaged updater cleanup unconfirmed; retained ${home}`, { cause: error });
  }
}

it.runIf(!!process.env.PUDDLE_TEST_RUNTIME_RELEASE)(
  'runs the packaged owner and pinned native dependencies through controller replacement',
  async () => {
    let stage = resolve(process.env.PUDDLE_TEST_RUNTIME_RELEASE!);
    const f = prepare();
    const version = readFileSync(join(stage, 'VERSION'), 'utf8').trim();
    const archive = process.env.PUDDLE_TEST_RUNTIME_ARCHIVE;
    // Package composition uses the existing isolated scripted manager. Native
    // launchd/systemd lifetime acceptance remains a separate explicit gate.
    const env = archive ? await continuitySupervisor(f.home) : environment(f.home);
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
          let worker: HostUpdateWorker | undefined;
          let startAttempted = false;
          let ended = false;
          try {
            worker = await startUpdateWorker(f.home, operation, {
              kind: 'systemd',
              releasePath: release,
              run: async (command) => {
                // Capture durable dispatch before executing even a lost start reply.
                worker = readUpdateWorker(f.home, operation.id);
                expect(command.file).toBe('systemctl');
                if (command.args[1] === 'start') startAttempted = true;
                return runCompilationCommand({ ...command, env });
              },
            });
            await waitFor(() =>
              ['complete', 'failed', 'recovery_required'].includes(store.read(operation.id)!.phase),
            );
            const log = join(f.home, 'test-services', `${worker.name}.log`);
            const completed = store.read(operation.id)!;
            expect(completed, existsSync(log) ? readFileSync(log, 'utf8') : '').toMatchObject({
              phase: 'complete',
              verification: expect.stringMatching(/^[a-f0-9]{64}$/),
            });
            const actualPid = Number(
              readFileSync(join(f.home, 'test-services', `${worker.name}.pid`), 'utf8'),
            );
            const lifetime = hostUpdateWorkerLifetimeSchema.parse(
              JSON.parse(
                readFileSync(
                  join(updateWorkerDirectory(f.home, operation.id), 'lifetime.json'),
                  'utf8',
                ),
              ),
            );
            expect(lifetime.process_group).toBe(actualPid);
            await waitFor(() => {
              try {
                requireEndedUpdateWorker(f.home, worker!, completed);
                return true;
              } catch {
                return false;
              }
            });
            ended = true;
          } finally {
            if (worker && startAttempted) await cleanupPackagedWorker(f.home, env, worker, ended);
          }
          expect(readFileSync(join(f.home, 'test-services/mutations'), 'utf8')).not.toContain(
            `stop ${worker!.name}`,
          );
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
    expect(JSON.parse(readFileSync(join(stage, 'HOST_CAPABILITIES.json'), 'utf8'))).toEqual(
      hostReleaseCapabilities(version, DATABASE_SCHEMA_VERSION),
    );
    expect(
      JSON.parse(
        execFileSync(join(stage, 'puddled'), ['--host-capabilities'], {
          env,
          encoding: 'utf8',
          timeout: 5000,
        }),
      ),
    ).toEqual(hostReleaseCapabilities(version, DATABASE_SCHEMA_VERSION));
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
