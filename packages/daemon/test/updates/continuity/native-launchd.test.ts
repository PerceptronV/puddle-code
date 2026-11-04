import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type WebSocket from 'ws';
import { expect, it } from 'vitest';
import {
  hostStageReceiptSchema,
  hostUpdateWorkerSchema,
  hostUpdateWorkerLifetimeSchema,
  runtimeStateSchema,
  runtimeSupervisorSchema,
  sessionSchema,
} from '@puddle/shared';
import { atomicPrivateJson, digest, ipcPath, privateDirectory } from '@puddle/shared/node';
import { HostControlClient, updateWorkerExecutables } from '@puddle/shared/node/host-control';
import {
  independentServiceDefinition,
  writeServiceDefinition,
} from '../../../src/host/services.js';
import { prepareServiceReplacement } from '../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../src/host/supervision/inspection.js';
import { serviceIsStopped } from '../../../src/host/supervision/stopped.js';
import {
  readRuntimeController,
  readRuntimeJson,
  runtimeDirectory,
} from '../../../src/runtime/ownership/storage.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { readHostUpdateAdoption } from '../../../src/updates/checkpoints/adoption.js';
import { readHostUpdateCheckpoint } from '../../../src/updates/checkpoints/store.js';
import { readUpdateActions } from '../../../src/updates/worker/actions.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { requireEndedUpdateWorker } from '../../../src/updates/worker/lifetime.js';
import { readRuntime } from '../../../src/runtime-file.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { environment, retainRuntimeHome, terminal } from '../../helpers/runtime-fixture.js';
import { continuityRelease, installer } from '../../helpers/update-continuity/release.js';
import {
  nativeJobs,
  nativeJobLog,
  nativeViewer,
  nativeWait,
} from '../../helpers/update-continuity/native.js';
import { sh } from '../../helpers/git-fixtures.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'replaces a bundled daemon through native launchd while its independent runtime keeps shell state',
  async () => {
    const f = runtimeDatabase();
    const home = realpathSync(f.home);
    const env = { ...environment(home), PUDDLE_HOME: home };
    const jobs = nativeJobs(home);
    const domain = `gui/${process.getuid!()}`;
    const daemonTarget = {
      kind: 'launchd' as const,
      name: `dev.puddle.test.daemon.${randomUUID()}`,
      domain,
    };
    jobs.add(daemonTarget);
    const controls: HostControlClient[] = [];
    const sockets: WebSocket[] = [];
    let worker: ReturnType<typeof hostUpdateWorkerSchema.parse> | undefined;
    const authority = async () => {
      const control = new HostControlClient(async () => connect(ipcPath(home, 'host')));
      controls.push(control);
      await control.establish();
      return control;
    };
    const state = (id: string) =>
      runtimeStateSchema.parse(readRuntimeJson(join(runtimeDirectory(home, id), 'state.json')));
    const ownerService = (id: string) => {
      const record = runtimeSupervisorSchema.parse(
        readRuntimeJson(join(runtimeDirectory(home, id), 'supervisor.json')),
      );
      if (record.kind !== 'launchd' || record.domain !== domain)
        throw new Error('Runtime did not use native launchd');
      const target = { kind: record.kind, name: record.name, domain };
      jobs.add(target);
      return target;
    };
    const create = async (control: HostControlClient) => {
      const response = await fetch(`http://127.0.0.1:${control.port}/api/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.credential()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ project_id: f.project.id, kind: 'terminal', cwd: '.' }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(201);
      const session = sessionSchema.parse(body);
      const owner = f.runtimes.ownerOf(session.id)!;
      const target = ownerService(owner.runtime_id);
      const pid = await jobs.observe(target);
      expect(pid).toBeGreaterThan(0);
      const shell = terminal(state(owner.runtime_id)).pid;
      if (shell) jobs.remember(target, shell);
      return { session, owner, target, pid };
    };
    const install = (
      archive: string,
      version: string,
      component: 'daemon' | 'runtime',
      stage = false,
    ) =>
      promisify(execFile)(
        '/bin/sh',
        [
          installer,
          '--version',
          version,
          '--tarball',
          archive,
          '--sums',
          `${archive}.sha256`,
          '--component',
          component,
          ...(stage ? ['--stage-only'] : ['--no-supervisor']),
        ],
        { env, timeout: 45_000 },
      );
    const withLog = (definition: string, name: string) =>
      definition.replace(
        '</dict></plist>',
        `<key>StandardOutPath</key><string>${nativeJobLog(home, name)}</string><key>StandardErrorPath</key><string>${nativeJobLog(home, name)}</string></dict></plist>`,
      );
    try {
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
      await f.reconciler.close();
      f.controller.release();
      sh(home, 'init', '-b', 'main');
      const previousArchive = await continuityRelease(home, '0.3.14', true);
      await install(previousArchive, '0.3.14', 'daemon');
      await install(previousArchive, '0.3.14', 'runtime');
      writeFileSync(join(home, 'supervisor'), 'launchd\n', { mode: 0o600 });
      const plist = join(home, 'test-daemon.plist');
      const definition = withLog(
        independentServiceDefinition({
          home,
          kind: 'launchd',
          name: daemonTarget.name,
          description: 'Isolated native daemon upgrade fixture',
          args: [join(home, 'bin/current/puddled')],
        }).replace('<key>KeepAlive</key><false/>', '<key>KeepAlive</key><true/>'),
        daemonTarget.name,
      );
      writeServiceDefinition(plist, definition);
      expect(await serviceIsStopped(home, daemonTarget, jobs.run)).toBe(true);
      await jobs.execute(['bootstrap', domain, plist]);
      await nativeWait(() => !!readRuntime(f.paths), 'Native daemon did not become ready');
      const first = await authority();
      const daemonPid = await jobs.observe(daemonTarget);
      expect(daemonPid).toBe(readRuntime(f.paths)!.pid);
      const controller = readRuntimeController(home);
      const original = await create(first);
      const main = terminal(state(original.owner.runtime_id));
      const viewer = await nativeViewer(first, original.session.id, sockets);
      viewer.input(
        'set +H\nstty -echo; preserved=native_upgrade; cd /; sleep 180 & background=$!; printf "before:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
      );
      await nativeWait(
        () => viewer.text().includes('before:native_upgrade:/:'),
        'Native shell did not accept input',
      );
      const background = /before:native_upgrade:\/:(\d+)/.exec(viewer.text())![1]!;
      jobs.remember(original.target, Number(background));

      // Deliberate test boundary: production coordinator preflight hard-codes
      // dev.puddle.puddled. Never register that installed-service name. Prepare
      // approval/dispatch here; the deterministic sibling covers the coordinator.
      // Every subsequent worker, native service, installer and adoption step is real.
      const archive = await continuityRelease(home, '0.4.0', true);
      const store = new HostUpdateOperations(home);
      let operation = store.begin([
        { component: 'daemon', version: '0.4.0' },
        { component: 'runtime', version: '0.4.0' },
      ]).operation;
      for (const component of ['daemon', 'runtime'] as const) {
        const output = await install(archive, '0.4.0', component, true);
        const line = output.stdout
          .split('\n')
          .find((value) => value.startsWith('PUDDLE_HOST_STAGE '))!;
        operation = store.staged(
          operation,
          hostStageReceiptSchema.parse(JSON.parse(line.slice('PUDDLE_HOST_STAGE '.length))),
        );
      }
      const service = await prepareServiceReplacement(
        home,
        await inspectRunningService(home, daemonTarget, daemonPid!, jobs.run),
        { definitionPath: plist, run: jobs.run },
      );
      operation = store.preflight(
        operation,
        digest(JSON.stringify({ service, stages: operation.stages, controller })),
      );
      operation = store.approve(operation, operation.preflight!);
      operation = store.dispatch(operation);
      const release = realpathSync(join(home, 'bin/current'));
      worker = hostUpdateWorkerSchema.parse({
        format: 1,
        operation_id: operation.id,
        dispatch_id: operation.dispatch_id,
        dispatch_revision: operation.revision,
        preflight: operation.preflight,
        kind: 'launchd',
        name: `dev.puddle.test.update.${operation.id}`,
        domain,
        ...updateWorkerExecutables(home, release),
        state: 'dispatched',
        outgoing: { pid: daemonPid, controller: { id: controller.id, epoch: controller.epoch } },
        daemon_service: service,
        connector: { state: 'absent' },
      });
      jobs.add(worker);
      const directory = updateWorkerDirectory(home, operation.id);
      privateDirectory(directory);
      atomicPrivateJson(join(directory, 'worker.json'), worker);
      const workerPlist = join(directory, 'update.plist');
      writeServiceDefinition(
        workerPlist,
        withLog(
          independentServiceDefinition({
            home,
            kind: 'launchd',
            name: worker.name,
            description: 'Isolated native update worker',
            args: [
              '/usr/bin/env',
              '-i',
              ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
              worker.node_path,
              worker.entry_path,
              '--home',
              home,
              '--operation',
              operation.id,
            ],
            timeoutSeconds: 180,
          }),
          worker.name,
        ),
      );
      await jobs.execute(['bootstrap', domain, workerPlist]);
      first.close();
      await nativeWait(
        () => ['complete', 'recovery_required'].includes(store.read(operation.id)!.phase),
        'Native update did not finish',
        60_000,
      );
      const completed = store.read(operation.id)!;
      const log = existsSync(nativeJobLog(home, worker.name))
        ? readFileSync(nativeJobLog(home, worker.name), 'utf8')
        : '';
      expect(completed, log).toMatchObject({
        phase: 'complete',
        verification: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const adoption = readHostUpdateAdoption(home, operation.id);
      expect(adoption.daemon.pid).not.toBe(daemonPid);
      expect(adoption.daemon.pid).toBe(await jobs.observe(daemonTarget));
      expect(adoption.daemon.controller.epoch).toBeGreaterThan(controller.epoch);
      expect(readHostUpdateCheckpoint(home, operation.id).owners).toContainEqual(
        expect.objectContaining({
          identity: expect.objectContaining({ runtime_id: original.owner.runtime_id }),
        }),
      );
      expect(adoption.owners).toContainEqual(
        expect.objectContaining({ runtime_id: original.owner.runtime_id, state: 'running' }),
      );
      expect(
        readUpdateActions(home, worker, completed).actions.every(
          (action) => action.state === 'finished',
        ),
      ).toBe(true);
      await nativeWait(() => {
        try {
          requireEndedUpdateWorker(home, worker!, completed);
          return true;
        } catch {
          return false;
        }
      }, 'Native updater process group did not end');
      expect(readFileSync(plist, 'utf8')).toBe(definition);
      expect(await jobs.observe(original.target)).toBe(original.pid);
      expect(terminal(state(original.owner.runtime_id))).toMatchObject({
        pid: main.pid,
        generation: main.generation,
      });
      expect(f.runtimes.ownerOf(original.session.id)).toMatchObject({
        runtime_id: original.owner.runtime_id,
        release_path: original.owner.release_path,
        build: '0.3.14',
      });
      const next = await authority();
      expect(next.version?.version).toBe('0.4.0');
      const adopted = await nativeViewer(next, original.session.id, sockets);
      expect(adopted.text()).toContain(`before:native_upgrade:/:${background}`);
      adopted.input(
        'kill -0 "$background" && printf "after:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
      );
      await nativeWait(
        () => adopted.text().includes(`after:native_upgrade:/:${background}`),
        'Native shell state did not survive',
      );
      const fresh = await create(next);
      expect(fresh.owner).toMatchObject({
        build: '0.4.0',
        release_path: realpathSync(join(home, 'bin/runtime-current')),
      });
      expect(fresh.owner.runtime_id).not.toBe(original.owner.runtime_id);
    } finally {
      for (const control of controls) control.close();
      for (const ws of sockets) ws.terminate();
      try {
        // Include any accepted runtime launch whose HTTP reply was lost.
        for (const owner of f.runtimes.live()) {
          if (existsSync(join(runtimeDirectory(home, owner.runtime_id), 'supervisor.json')))
            ownerService(owner.runtime_id);
        }
        if (worker) {
          const path = join(updateWorkerDirectory(home, worker.operation_id), 'lifetime.json');
          if (existsSync(path))
            jobs.rememberGroup(
              worker,
              hostUpdateWorkerLifetimeSchema.parse(readRuntimeJson(path)).process_group,
            );
        }
        await jobs.cleanup();
      } catch (error) {
        retainRuntimeHome(home);
        // eslint-disable-next-line no-unsafe-finally -- Preserve executables whenever native cleanup cannot be proved.
        throw new Error(`Native upgrade cleanup failed; retained ${home}`, { cause: error });
      } finally {
        f.db.close();
      }
    }
  },
  150_000,
);
