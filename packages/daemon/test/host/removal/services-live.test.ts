import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { hostServiceReplacementSchema } from '@puddle/shared';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import { HostRemovalGuard } from '../../../src/host/removal/guard.js';
import { reviewRemovalService } from '../../../src/host/removal/services.js';
import { HostRemovalServiceOperation } from '../../../src/host/removal/operations/services.js';
import { HostRemovalServiceRestore } from '../../../src/host/removal/restoration/services.js';
import { startReplacementService } from '../../../src/host/supervision/replacement.js';
import { inspectLaunchdProcess } from '../../../src/host/supervision/launchd.js';
import { serviceIsRemoved } from '../../../src/host/supervision/removed.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'recovers native removal and restores its service while the neighbouring job survives',
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
    const release = join(home, 'bin/versions/0.4.0~abc123');
    mkdirSync(release, { recursive: true, mode: 0o700 });
    symlinkSync(release, join(home, 'bin/current'));
    const wrapper = join(home, 'bin/current/puddled');
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
    let guard = HostRemovalGuard.acquire(home);
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
      let writes = 0;
      const operation: HostRemovalServiceOperation = await HostRemovalServiceOperation.prepare(
        guard,
        [review],
        {
          authorised: () => true,
          write: (path, value, options) => {
            if (++writes === 3) throw new Error('Lost completion write');
            atomicPrivateJson(path, value, options);
          },
          run: async (command) => {
            if (command.args[0] === 'bootout') {
              expect(operation.read().actions[0]!.state).toBe('started');
              expect(command.args[1]).toBe(`${domain}/${selected!.target.name}`);
              stops++;
              const result = await nativeRun(command);
              expect(result.exitCode).toBe(0);
              throw new Error('Lost native stop reply');
            }
            return nativeRun(command);
          },
        },
      );
      await expect(operation.stop('daemon')).rejects.toThrow('Lost completion write');
      expect(stops).toBe(1);
      expect(existsSync(selected!.definition)).toBe(true);
      expect(() => process.kill(selected!.pid!, 0)).toThrow();
      guard.release();
      guard = HostRemovalGuard.acquire(home);
      const resumed = HostRemovalServiceOperation.open(guard, {
        authorised: () => true,
        run: nativeRun,
      });
      await expect(resumed.stop('daemon')).rejects.toThrow('already attempted');
      await resumed.observe('daemon', 'stop');
      controller = guard.acquireController();
      await resumed.unregister('daemon');
      expect(resumed.read().actions.map(({ state }) => state)).toEqual(['finished', 'finished']);
      expect(resumed.read().services[0]!.review).toEqual(review);
      expect(existsSync(release)).toBe(true);
      expect(existsSync(selected!.definition)).toBe(false);
      expect(await serviceIsRemoved(home, selected!.target, nativeRun)).toBe(true);
      expect(await inspectLaunchdProcess(home, neighbour!.target, nativeRun)).toBe(neighbour!.pid);
      expect(existsSync(neighbour!.definition)).toBe(true);
      const restored = new HostRemovalServiceRestore(guard, resumed, {
        authorised: () => true,
        run: nativeRun,
        userHome: home,
      });
      await restored.restore();
      expect(() => requireNoHostRemoval(home)).toThrow();
      await restored.handoff();
      requireNoHostRemoval(home);
      // The ordinary startup primitive uses the unique fixture label, never the installed daemon.
      await startReplacementService(
        home,
        hostServiceReplacementSchema.parse({
          ...review.process,
          component: 'daemon',
          definition_path: review.definition,
          definition_digest: review.definitionDigest,
        }),
        guard.commands(nativeRun),
        true,
        () => {
          controller!.release();
        },
      );
      const deadline = Date.now() + 10_000;
      selected!.pid = null;
      while (selected!.pid === null && Date.now() < deadline) {
        selected!.pid = await inspectLaunchdProcess(home, selected!.target, nativeRun);
        if (selected!.pid === null) await delay(25);
      }
      expect(selected!.pid).toBeGreaterThan(0);
      expect(selected!.pid).not.toBe(review.process!.pid);
      expect(await inspectLaunchdProcess(home, neighbour!.target, nativeRun)).toBe(neighbour!.pid);
    } finally {
      controller?.release();
      guard.release();
      await cleanup();
    }
  },
);
