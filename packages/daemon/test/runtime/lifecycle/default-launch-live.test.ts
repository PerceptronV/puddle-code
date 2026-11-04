import { once } from 'node:events';
import { copyFileSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeSupervisorSchema, sessionSchema } from '@puddle/shared';
import {
  CompilationCommandError,
  runCompilationCommand,
} from '../../../src/compilation/process.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import {
  bundleDir,
  environment,
  launchOwner,
  retainRuntimeHome,
} from '../../helpers/runtime-fixture.js';
import { sh } from '../../helpers/git-fixtures.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'creates and adopts an installed runtime through default daemon composition and native launchd',
  async () => {
    const f = runtimeDatabase();
    let daemon: ReturnType<typeof launchOwner> | undefined;
    let ready: { port: number; token: string } | undefined;
    const owners = new Set<string>();
    const execute = (args: string[]) =>
      runCompilationCommand({
        file: '/bin/launchctl',
        args,
        cwd: f.home,
        env: environment(f.home),
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      }).catch((error: unknown) => {
        if (error instanceof CompilationCommandError && error.result) return error.result;
        throw error;
      });
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
      const ended = once(daemon!.child, 'exit');
      daemon!.child.kill('SIGTERM');
      expect((await ended)[0]).toBe(0);
    };
    try {
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
      sh(f.home, 'init', '-b', 'main');
      const release = runtimeRelease(f.home, '0.4.0-test');
      copyFileSync(process.execPath, join(release.release, 'bin', 'node'));
      copyFileSync(
        join(bundleDir, 'provider-owner.mjs'),
        join(release.release, 'daemon', 'puddler.mjs'),
      );
      cpSync(join(bundleDir, 'node_modules'), join(release.release, 'node_modules'), {
        recursive: true,
      });
      release.select();
      writeFileSync(join(f.home, 'test-default-runtime-launcher'), '');
      f.controller.release();
      await start();
      const response = await fetch(`http://127.0.0.1:${ready!.port}/api/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: f.project.id, kind: 'terminal', cwd: '.' }),
        signal: AbortSignal.timeout(25_000),
      });
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(201);
      const session = sessionSchema.parse(body);
      const owner = f.runtimes.ownerOf(session.id)!;
      owners.add(owner.runtime_id);
      expect(owner).toMatchObject({ state: 'running', build: '0.4.0-test' });
      const state = () =>
        readRuntimeJson(join(runtimeDirectory(f.home, owner.runtime_id), 'state.json')) as {
          terminals: Array<{ pid: number }>;
        };
      const pid = state().terminals[0]!.pid;
      expect(pid).toBeGreaterThan(0);
      await stop();
      process.kill(pid, 0);
      await start();
      expect(state().terminals[0]!.pid).toBe(pid);
      expect(f.runtimes.ownerOf(session.id)?.runtime_id).toBe(owner.runtime_id);
      const killed = await fetch(
        `http://127.0.0.1:${ready!.port}/api/sessions/${session.id}/kill`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${ready!.token}` },
          signal: AbortSignal.timeout(25_000),
        },
      );
      expect(killed.status).toBe(200);
      await killed.arrayBuffer();
      await stop();
    } finally {
      try {
        if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null)
          await stop();
        // Only jobs recorded under this isolated home; verify absence before its removal.
        for (const id of new Set([
          ...owners,
          ...f.runtimes.live().map((owner) => owner.runtime_id),
        ])) {
          const record = runtimeSupervisorSchema.parse(
            readRuntimeJson(join(runtimeDirectory(f.home, id), 'supervisor.json')),
          );
          const target = `${record.domain!}/${record.name}`;
          const before = await execute(['print', target]);
          if (before.exitCode !== 113) {
            expect(before.exitCode).toBe(0);
            await execute(['bootout', target]);
          }
          expect((await execute(['print', target])).exitCode).toBe(113);
        }
      } catch (error) {
        retainRuntimeHome(f.home);
        // eslint-disable-next-line no-unsafe-finally -- Surface unconfirmed native cleanup and its retained executable tree.
        throw new Error(`Native test cleanup is unconfirmed; retained ${f.home}`, { cause: error });
      } finally {
        await f.reconciler.close();
        f.db.close();
      }
    }
  },
);
