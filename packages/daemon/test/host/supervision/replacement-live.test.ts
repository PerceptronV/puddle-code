import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import { inspectRunningService } from '../../../src/host/supervision/inspection.js';
import {
  prepareServiceReplacement,
  serviceIsStopped,
  startReplacementService,
  stopServiceForReplacement,
} from '../../../src/host/supervision/replacement.js';

it
  .runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')
  .each(['daemon', 'connector'] as const)(
  'stops a KeepAlive launchd %s fixture and restarts its unchanged custom configuration',
  async (component) => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-replacement-live-'));
    const name = `dev.puddle.test.replacement.${randomUUID()}`;
    const domain = `gui/${process.getuid!()}`;
    const target = { kind: 'launchd' as const, name, domain };
    const definitionPath = join(home, 'fixture.plist');
    const status = join(home, 'started.json');
    const wrapper = join(home, 'bin/current/puddled');
    const entry =
      component === 'connector'
        ? join(home, 'bin/current/daemon/connector.mjs')
        : join(home, 'fixture.mjs');
    const node = join(home, 'bin/current/bin/node');
    const args = component === 'connector' ? [node, entry] : [wrapper];
    const xml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    mkdirSync(join(home, 'bin/current/daemon'), { recursive: true });
    mkdirSync(join(home, 'bin/current/bin'), { recursive: true });
    if (component === 'connector') copyFileSync(process.execPath, node);
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(status)}, JSON.stringify({ pid: process.pid, custom: process.env.PUDDLE_TEST_CUSTOM }));
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
setInterval(() => {}, 1000);
`,
    );
    // A provider-free fixture only. No installed daemon, agent or user service is launched.
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)}\n`, {
      mode: 0o700,
    });
    const definition = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>PUDDLE_TEST_CUSTOM</key><string>preserved</string></dict></dict></plist>`;
    writeFileSync(definitionPath, definition, { mode: 0o600 });
    const run: CompilationCommandRunner = (command) =>
      runCompilationCommand({
        ...command,
        env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    const execute = (args: string[]) =>
      run({
        file: '/bin/launchctl',
        args,
        cwd: home,
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      });
    const waitStarted = async (previous = 0) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const result = JSON.parse(readFileSync(status, 'utf8')) as {
            pid: number;
            custom: string;
          };
          if (result.pid !== previous) return result;
        } catch {
          /* Await this one submitted launch. */
        }
        if (Date.now() >= deadline) throw new Error('Native fixture did not start');
        await delay(25);
      }
    };
    const cleanup = async () => {
      let cleaned = false;
      try {
        if (!(await serviceIsStopped(home, target, run)))
          await execute(['bootout', `${domain}/${name}`]);
        const deadline = Date.now() + 10_000;
        while (!(await serviceIsStopped(home, target, run))) {
          if (Date.now() >= deadline) throw new Error('Native cleanup is unconfirmed');
          await delay(25);
        }
        const pid: unknown = (() => {
          try {
            return (JSON.parse(readFileSync(status, 'utf8')) as { pid?: unknown }).pid;
          } catch {
            return undefined;
          }
        })();
        if (typeof pid === 'number') {
          for (;;) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
              throw error;
            }
            if (Date.now() >= deadline) throw new Error('Native process exit is unconfirmed');
            await delay(25);
          }
        }
        cleaned = true;
      } catch (error) {
        // No installed service is touched; preserve the fixture if its removal is uncertain.
        throw new Error(`Native service cleanup failed; retained ${home}`, { cause: error });
      } finally {
        if (cleaned) rmSync(home, { recursive: true, force: true });
      }
    };
    try {
      await execute(['bootstrap', domain, definitionPath]);
      const first = await waitStarted();
      const observed = await inspectRunningService(home, target, first.pid, run);
      const replacement = await prepareServiceReplacement(home, observed, {
        definitionPath,
        component,
        run,
      });
      await stopServiceForReplacement(home, replacement, () => {}, run);
      const deadline = Date.now() + 10_000;
      while (!(await serviceIsStopped(home, target, run))) {
        if (Date.now() >= deadline) throw new Error('Native stop is unconfirmed');
        await delay(25);
      }
      // Allow the fixture's delayed signal handler to finish; registration absence
      // remains the evidence that KeepAlive cannot restart it.
      await delay(1200);
      expect(() => process.kill(first.pid, 0)).toThrow();
      expect(JSON.parse(readFileSync(status, 'utf8')).pid).toBe(first.pid);
      expect(readFileSync(definitionPath, 'utf8')).toBe(definition);
      await startReplacementService(home, replacement, run);
      const second = await waitStarted(first.pid);
      expect(second.custom).toBe('preserved');
      expect(readFileSync(definitionPath, 'utf8')).toBe(definition);
    } finally {
      await cleanup();
    }
  },
);
