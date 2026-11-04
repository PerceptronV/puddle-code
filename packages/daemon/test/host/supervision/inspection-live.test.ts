import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  CompilationCommandError,
  runCompilationCommand,
} from '../../../src/compilation/process.js';
import {
  independentServiceDefinition,
  writeServiceDefinition,
} from '../../../src/host/services.js';
import {
  inspectRunningService,
  inspectServiceManager,
} from '../../../src/host/supervision/inspection.js';

it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
  'identifies an isolated native launchd job and rejects its old PID after a restart',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-service-inspection-')));
    const service = {
      kind: 'launchd' as const,
      name: `dev.puddle.test.inspection.${randomUUID()}`,
      domain: `gui/${process.getuid!()}`,
    };
    const target = `${service.domain}/${service.name}`;
    const pidFile = join(home, 'pid');
    const definition = join(home, 'inspection.plist');
    const execute = async (args: string[]) => {
      try {
        return await runCompilationCommand({
          file: '/bin/launchctl',
          args,
          cwd: home,
          timeoutMs: 15000,
          maxOutputBytes: 64 * 1024,
        });
      } catch (error) {
        if (error instanceof CompilationCommandError && error.result) return error.result;
        throw error;
      }
    };
    const waitPid = async (previous = 0) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const pid = Number(readFileSync(pidFile, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== previous) return pid;
        } catch {
          /* The isolated service has not written its identity yet. */
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Isolated service did not report a PID');
    };
    writeServiceDefinition(
      definition,
      independentServiceDefinition({
        home,
        ...service,
        description: 'Puddle service inspection test',
        args: [
          process.execPath,
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
          pidFile,
        ],
      }),
    );
    try {
      const manager = await inspectServiceManager(home, 'launchd', process.getuid!());
      expect(manager).toEqual({ kind: 'launchd', domain: service.domain });
      expect((await execute(['bootstrap', service.domain, definition])).exitCode).toBe(0);
      const before = await waitPid();
      expect((await inspectRunningService(home, service, before)).pid).toBe(before);
      expect((await execute(['kickstart', '-k', target])).exitCode).toBe(0);
      const after = await waitPid(before);
      await expect(inspectRunningService(home, service, before)).rejects.toThrow('does not match');
      expect((await inspectRunningService(home, service, after)).pid).toBe(after);
    } finally {
      const removal = await execute(['bootout', target]);
      expect([0, 113]).toContain(removal.exitCode);
      expect((await execute(['print', target])).exitCode).toBe(113);
      rmSync(home, { recursive: true, force: true });
    }
  },
  45000,
);
