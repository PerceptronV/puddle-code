import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import { HostRemovalGuard } from '../../../src/host/removal/guard.js';
import {
  reviewRemovalService,
  stopRemovalService,
  unregisterRemovalService,
} from '../../../src/host/removal/services.js';
import { inspectLaunchdProcess } from '../../../src/host/supervision/launchd.js';
import { serviceIsRemoved } from '../../../src/host/supervision/removed.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'removes only the reviewed native job after a lost stop reply',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-removal-live-'));
    const domain = `gui/${process.getuid!()}`;
    const jobs = ['selected', 'neighbour'].map((suffix) => {
      const name = `dev.puddle.test.removal.${randomUUID()}.${suffix}`;
      const target = { kind: 'launchd' as const, name, domain };
      const definition = join(home, 'Library/LaunchAgents', `${name}.plist`);
      return { target, definition, pid: null as number | null };
    });
    const [selected, neighbour] = jobs;
    const wrapper = join(home, 'bin/current/puddled');
    mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
    // A sanitised fake process, never the installed daemon or a provider CLI.
    writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin /bin/sleep 120\n', {
      mode: 0o700,
    });
    const xml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const job of jobs) {
      mkdirSync(dirname(job.definition), { recursive: true, mode: 0o700 });
      writeFileSync(
        job.definition,
        `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${job.target.name}</string><key>ProgramArguments</key><array><string>${xml(wrapper)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`,
        { mode: 0o600 },
      );
    }
    const nativeRun: CompilationCommandRunner = (command) =>
      runCompilationCommand({
        ...command,
        env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    const raw = (args: string[]) =>
      nativeRun({
        file: '/bin/launchctl',
        args,
        cwd: home,
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      });
    const guard = HostRemovalGuard.acquire(home);
    let controller: ReturnType<typeof guard.acquireController> | undefined;
    const cleanup = async () => {
      for (const job of jobs) {
        if (!(await serviceIsRemoved(home, job.target, nativeRun)))
          await raw(['bootout', `${domain}/${job.target.name}`]);
        // Retain all fixture files if either registration or process end is uncertain.
        expect(await serviceIsRemoved(home, job.target, nativeRun)).toBe(true);
        const deadline = Date.now() + 10_000;
        while (job.pid !== null) {
          try {
            process.kill(job.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
            throw error;
          }
          if (Date.now() >= deadline) throw new Error(`Fixture process remains; retained ${home}`);
          await delay(25);
        }
      }
      rmSync(home, { recursive: true, force: true });
    };
    try {
      for (const job of jobs) {
        expect((await raw(['bootstrap', domain, job.definition])).exitCode).toBe(0);
        const deadline = Date.now() + 10_000;
        while (job.pid === null && Date.now() < deadline) {
          job.pid = await inspectLaunchdProcess(home, job.target, nativeRun);
          if (job.pid === null) await delay(25);
        }
        expect(job.pid).toBeGreaterThan(0);
      }
      const review = await reviewRemovalService(guard, selected!.target, 'daemon', selected!.pid, {
        userHome: home,
        run: nativeRun,
      });
      let stops = 0;
      let recorded = false;
      await stopRemovalService(
        guard,
        review,
        () => true,
        () => {
          recorded = true;
        },
        async (command) => {
          if (command.args[0] === 'bootout') {
            expect(recorded).toBe(true);
            expect(command.args[1]).toBe(`${domain}/${selected!.target.name}`);
            stops++;
            const result = await nativeRun(command);
            expect(result.exitCode).toBe(0);
            throw new Error('Lost native stop reply');
          }
          return nativeRun(command);
        },
      );
      expect(stops).toBe(1);
      expect(existsSync(selected!.definition)).toBe(true);
      expect(() => process.kill(selected!.pid!, 0)).toThrow();
      controller = guard.acquireController();
      await unregisterRemovalService(
        guard,
        review,
        () => true,
        () => {},
        nativeRun,
      );
      expect(existsSync(selected!.definition)).toBe(false);
      expect(await serviceIsRemoved(home, selected!.target, nativeRun)).toBe(true);
      expect(await inspectLaunchdProcess(home, neighbour!.target, nativeRun)).toBe(neighbour!.pid);
      expect(existsSync(neighbour!.definition)).toBe(true);
    } finally {
      controller?.release();
      guard.release();
      await cleanup();
    }
  },
);
