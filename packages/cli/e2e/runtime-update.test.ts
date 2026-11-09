import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { hostUpdateLedgerSchema, hostUpdateWorkerSchema } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { findFreePort } from '../src/lib/transport/net.js';
import { root, stop, until } from './helpers.js';
import { packagedHuddle } from './helpers/huddle.js';
import { checkHuddleSsh } from './helpers/huddle-ssh.js';

const archive = process.env.PUDDLE_TEST_RUNTIME_ARCHIVE;
const ssh = process.env.PUDDLE_TEST_HUDDLE_SSH === '1';
const enabled =
  process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1' && !!archive;

function workerIds(home: string): string[] {
  try {
    return readdirSync(join(home, 'updates/jobs'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

it.runIf(enabled)(
  'updates an isolated installed runtime while a packaged huddle keeps its owner and executes',
  async () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-update-e2e-')));
    const home = join(temporary, '.puddle');
    const env = {
      HOME: temporary,
      PUDDLE_HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8',
    };
    const tarball = resolve(archive!);
    const version = /^puddled-v(\d+\.\d+\.\d+)-/.exec(tarball.split('/').at(-1)!)?.[1];
    if (!version) throw new Error('The packaged fixture must use a versioned host archive');
    const execute = (file: string, args: string[]) =>
      promisify(execFile)(file, args, {
        cwd: temporary,
        env,
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    const native = async (args: string[]) => {
      try {
        await execute('/bin/launchctl', args);
        return 0;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') return code;
        throw error;
      }
    };
    let daemon: ChildProcess | undefined;
    let huddle: Awaited<ReturnType<typeof packagedHuddle>> | undefined;
    let retainHome = false;
    try {
      // Temporary home, explicit environment and no installed service registration.
      for (const component of ['daemon', 'runtime']) {
        await execute('/bin/sh', [
          join(root, 'scripts/install.sh'),
          '--version',
          version,
          '--tarball',
          tarball,
          '--sums',
          `${tarball}.sha256`,
          '--no-supervisor',
          '--component',
          component,
        ]);
      }
      const selected = realpathSync(join(home, 'bin/current'));
      const original = realpathSync(join(home, 'bin/runtime-current'));
      const supervisor = readFileSync(join(home, 'supervisor'), 'utf8');
      const port = await findFreePort();
      daemon = spawn(join(selected, 'puddled'), ['--port', String(port)], {
        cwd: temporary,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      daemon.stdout!.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
      });
      daemon.stderr!.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
      });
      await until(() => {
        if (daemon!.exitCode !== null) throw new Error(`Isolated daemon exited: ${output}`);
        return output.includes('listening on');
      }, Boolean);
      const pid = daemon.pid;
      const worktree = join(temporary, 'project');
      await execute('/usr/bin/git', ['init', '-b', 'main', worktree]);
      retainHome = true;
      huddle = await packagedHuddle(home, port, worktree, ssh);
      await huddle.run('Before runtime selection');
      const cli = join(root, 'packages/cli/dist/index.js');
      const result = await execute(process.execPath, [
        cli,
        'upgrade',
        `runtime@${version}`,
        '--tarball',
        tarball,
      ]);
      expect(result.stderr + result.stdout).toContain('running runtimes keep their pinned build');
      const ledger = hostUpdateLedgerSchema.parse(
        JSON.parse(readFileSync(join(home, 'updates/operations.json'), 'utf8')),
      );
      const operation = ledger.current!;
      expect(operation.phase).toBe('complete');
      expect(operation.verification).toMatch(/^[a-f0-9]{64}$/);
      expect(realpathSync(join(home, 'bin/runtime-current'))).not.toBe(original);
      expect(realpathSync(join(home, 'bin/current'))).toBe(selected);
      expect(readFileSync(join(home, 'supervisor'), 'utf8')).toBe(supervisor);
      expect(daemon.pid).toBe(pid);
      expect(daemon.exitCode).toBeNull();
      expect(() => process.kill(pid!, 0)).not.toThrow();
      await huddle.run('After runtime selection');
      if (ssh) await checkHuddleSsh(home, port, huddle);
      const job = hostUpdateWorkerSchema.parse(
        JSON.parse(readFileSync(join(home, 'updates/jobs', operation.id, 'worker.json'), 'utf8')),
      );
      expect(job.release_path).toBe(selected);
      expect(job.node_path).toBe(join(selected, 'bin/node'));
      expect(await native(['print', `${job.domain}/${job.name}`])).toBe(0);
      const status = await execute(process.execPath, [cli, 'updates', '--operation', operation.id]);
      expect(status.stdout + status.stderr).toContain(`${operation.id} on this machine: complete`);
    } finally {
      try {
        try {
          if (huddle) {
            await huddle.stop();
            const service = `gui/${process.getuid!()}/dev.puddle.runtime.${digest(realpathSync(home)).slice(0, 8)}.${huddle.target.runtimeId}`;
            expect([0, 113]).toContain(await native(['bootout', service]));
            expect(await native(['print', service])).toBe(113);
            retainHome = false;
          }
        } finally {
          if (daemon) await stop(daemon);
        }
      } finally {
        for (const id of workerIds(home)) {
          const job = hostUpdateWorkerSchema.parse(
            JSON.parse(readFileSync(join(home, 'updates/jobs', id, 'worker.json'), 'utf8')),
          );
          expect(job.operation_id).toBe(id);
          expect(job.name).toBe(
            `dev.puddle.update.${digest(realpathSync(home)).slice(0, 8)}.${id}`,
          );
          expect(job.domain).toBe(`gui/${process.getuid!()}`);
          const target = `${job.domain}/${job.name}`;
          expect([0, 113]).toContain(await native(['bootout', target]));
          expect(await native(['print', target])).toBe(113);
        }
        // Retain files if registration absence could not be proven.
        if (!retainHome) rmSync(temporary, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
