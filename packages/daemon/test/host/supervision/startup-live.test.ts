import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { hostServiceReplacementSchema } from '@puddle/shared';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../src/compilation/process.js';
import { serviceDefinitionDigest } from '../../../src/host/supervision/definition.js';
import { inspectLaunchdProcess } from '../../../src/host/supervision/launchd.js';
import { startReplacementService } from '../../../src/host/supervision/replacement.js';
import { serviceHasNoProcess, serviceIsStopped } from '../../../src/host/supervision/stopped.js';
import { acquireHostClaim } from '../../../src/security/claims.js';

it
  .runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')
  .each([false, true])(
  'reloads an idle native job from its validated plist (lost bootout reply=%s)',
  async (lost) => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-idle-start-'));
    const name = `dev.puddle.test.idle.${randomUUID()}`;
    const domain = `gui/${process.getuid!()}`;
    const target = { kind: 'launchd' as const, name, domain };
    const definition = join(home, 'fixture.plist');
    const marker = join(home, 'started.json');
    const entry = join(home, 'fixture.mjs');
    const wrapper = join(home, 'bin/current/puddled');
    mkdirSync(join(home, 'bin/current'), { recursive: true, mode: 0o700 });
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,custom:process.env.PUDDLE_TEST_CUSTOM}));
setInterval(() => {}, 1000);
`,
    );
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)}\n`, {
      mode: 0o700,
    });
    const xml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const plist = (program: string, launch: boolean) =>
      `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${xml(program)}</string></array><key>RunAtLoad</key><${launch}/><key>KeepAlive</key><false/><key>EnvironmentVariables</key><dict><key>PUDDLE_TEST_CUSTOM</key><string>preserved</string></dict></dict></plist>`;
    // The loaded job deliberately differs from the file subsequently validated for startup.
    writeFileSync(definition, plist('/usr/bin/false', false), { mode: 0o600 });
    const mutations: string[] = [];
    const nativeRun: CompilationCommandRunner = (command) =>
      runCompilationCommand({
        ...command,
        env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    const run: CompilationCommandRunner = async (command) => {
      const result = await nativeRun(command);
      if (['bootout', 'bootstrap'].includes(command.args[0]!)) mutations.push(command.args[0]!);
      if (lost && command.args[0] === 'bootout') throw new Error('Bootout reply lost');
      return result;
    };
    const raw = (args: string[]) =>
      nativeRun({
        file: '/bin/launchctl',
        args,
        cwd: home,
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      });
    const claim = acquireHostClaim(home, 'daemon-controller');
    let startedPid: number | undefined;
    const cleanup = async () => {
      if (!(await serviceIsStopped(home, target, nativeRun)))
        expect((await raw(['bootout', `${domain}/${name}`])).exitCode).toBe(0);
      // Keep the fixture files if service removal cannot be established.
      expect(await serviceIsStopped(home, target, nativeRun)).toBe(true);
      if (startedPid) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          try {
            process.kill(startedPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
            throw error;
          }
          if (Date.now() >= deadline)
            throw new Error(`Native fixture process remains; retained ${home}`);
          await delay(25);
        }
      }
      rmSync(home, { recursive: true, force: true });
    };
    try {
      expect((await raw(['bootstrap', domain, definition])).exitCode).toBe(0);
      expect(await inspectLaunchdProcess(home, target, run)).toBeNull();
      expect(await serviceIsStopped(home, target, run)).toBe(false);
      expect(await serviceHasNoProcess(home, target, run)).toBe(true);
      const validated = plist(wrapper, true);
      writeFileSync(definition, validated, { mode: 0o600 });
      const service = hostServiceReplacementSchema.parse({
        ...target,
        component: 'daemon',
        pid: 2147483647,
        invocation: null,
        controlGroup: null,
        definition_path: definition,
        definition_digest: await serviceDefinitionDigest(home, target, definition, run),
      });
      const start = () =>
        startReplacementService(home, service, run, true, async () => {
          expect(() => acquireHostClaim(home, 'daemon-controller')).toThrow('owns this host claim');
          expect(await serviceIsStopped(home, target, run)).toBe(true);
          claim.release();
        });
      if (lost) {
        await expect(start()).rejects.toThrow('Bootout reply lost');
        expect(mutations).toEqual(['bootout']);
        expect(await serviceIsStopped(home, target, run)).toBe(true);
      }
      await start();
      expect(mutations).toEqual(['bootout', 'bootstrap']);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const observed = JSON.parse(readFileSync(marker, 'utf8')) as {
            pid: number;
            custom: string;
          };
          startedPid = observed.pid;
          expect(observed.custom).toBe('preserved');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(25);
      }
      expect(startedPid).toBeGreaterThan(0);
      expect(await inspectLaunchdProcess(home, target, run)).toBe(startedPid);
      expect(readFileSync(definition, 'utf8')).toBe(validated);
    } finally {
      claim.release();
      await cleanup();
    }
  },
);
