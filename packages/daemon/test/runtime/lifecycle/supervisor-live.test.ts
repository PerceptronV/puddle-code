import { placement } from '../../helpers/runtime-placement.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runtimeControllerSchema,
  runtimeStateSchema,
  runtimeSupervisorSchema,
} from '@puddle/shared';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import {
  startRuntimeService,
  removeRuntimeService,
} from '../../../src/runtime/lifecycle/supervisor.js';
import { runCompilationCommand } from '../../../src/compilation/process.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import {
  prepare,
  terminal,
  clients,
  controllers,
  waitForSnapshot,
  environment,
  bundleDir,
} from '../../helpers/runtime-fixture.js';

describe('native runtime supervision', () => {
  it.runIf(process.platform === 'darwin' && process.env.PUDDLE_TEST_RUNTIME_SUPERVISOR === '1')(
    'survives restarting an independent launchd controller job',
    async () => {
      const { home, launch, controller, directory } = prepare();
      const domain = `gui/${process.getuid!()}`;
      const label = `dev.puddle.test.controller.${randomUUID()}`;
      const target = `${domain}/${label}`;
      const execute = (args: string[]) =>
        runCompilationCommand({
          file: '/bin/launchctl',
          args,
          cwd: home,
          env: environment(home),
          timeoutMs: 15_000,
          maxOutputBytes: 64 * 1024,
        });
      const waitFor = async <T>(read: () => T | null): Promise<T> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            const value = read();
            if (value !== null) return value;
          } catch {
            /* Await isolated job startup. */
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Supervised fixture did not become ready');
      };
      try {
        await startRuntimeService(home, launch.identity, {
          kind: 'launchd',
          nodePath: process.execPath,
          entryPath: join(bundleDir, 'puddler.mjs'),
          run: async (command) => {
            if (command.args[0] === 'bootstrap') {
              const path = command.args[2]!;
              const content = readFileSync(path, 'utf8').replace(
                '</dict></plist>',
                `<key>StandardErrorPath</key><string>${join(home, 'owner-stderr.log')}</string></dict></plist>`,
              );
              writeFileSync(path, content, { mode: 0o600 });
            }
            return runCompilationCommand(command);
          },
        });
        try {
          await waitFor(() => {
            const state = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
            return state.state === 'running' ? state : null;
          });
        } catch {
          const record = runtimeSupervisorSchema.parse(
            readRuntimeJson(join(directory, 'supervisor.json')),
          );
          const printed = await execute(['print', `${record.domain}/${record.name}`]);
          const state = printed.stdout
            .match(/^\s*(state|pid|last exit code|last terminating signal) = .*$/gm)
            ?.join('\n');
          let stderr = '';
          try {
            stderr = readFileSync(join(home, 'owner-stderr.log'), 'utf8').slice(-2000);
          } catch {
            /* No stderr if exec failed. */
          }
          throw new Error(`Supervised runtime did not start: ${state}\n${stderr}`);
        }
        const client = await RuntimeClient.open(home, launch, controller.record);
        clients.push(client);
        const original = terminal(client.state);
        await client.request({
          placement: placement(client),
          t: 'input',
          term: 'agent',
          generation: original.generation,
          source: 'human',
          data: 'stty -echo; state=launchd; printf \'supervised-%s\\n\' "$state"\n',
        });
        await waitForSnapshot(client, original.generation, 'supervised-launchd');
        client.close();
        controller.release();
        const xml = (value: string) =>
          value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const plist = join(home, 'controller.plist');
        writeFileSync(
          plist,
          `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, join(bundleDir, 'controller.mjs'), home, launch.identity.runtime_id].map((value) => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`,
          { mode: 0o600 },
        );
        await execute(['bootstrap', domain, plist]);
        const readReady = () => {
          const ready = readRuntimeJson(join(home, 'controller-ready.json')) as {
            controller: unknown;
            pid: number;
          };
          return { ...ready, controller: runtimeControllerSchema.parse(ready.controller) };
        };
        const before = await waitFor(readReady);
        await execute(['kickstart', '-k', target]);
        const after = await waitFor(() => {
          const ready = readReady();
          return ready.controller.epoch > before.controller.epoch ? ready : null;
        });
        expect(after.pid).not.toBe(before.pid);
        await execute(['bootout', target]);
        const nextController = await waitFor(() => acquireRuntimeController(home));
        controllers.push(nextController);
        const next = await RuntimeClient.open(home, launch, nextController.record);
        clients.push(next);
        expect(terminal(next.state).pid).toBe(original.pid);
        await next.request({
          placement: placement(next),
          t: 'input',
          term: 'agent',
          generation: original.generation,
          source: 'human',
          data: 'printf \'restart-%s\\n\' "$state"\n',
        });
        await waitForSnapshot(next, original.generation, 'restart-launchd');
        await next.request({ t: 'stop', placement: placement(next) });
        await waitFor(() => {
          const claim = acquireHostClaim(home, `runtime:${launch.identity.runtime_id}`);
          claim.release();
          return true;
        });
        let bootedOut = false;
        expect(
          await removeRuntimeService(home, launch.identity, async (command) => {
            const result = await runCompilationCommand({ ...command, env: environment(home) });
            if (command.args[0] === 'bootout') {
              bootedOut = true;
              throw new Error('Lost bootout acknowledgement');
            }
            return result;
          }),
        ).toBe('removed');
        expect(bootedOut).toBe(true);
        expect(await removeRuntimeService(home, launch.identity)).toBe('removed');
      } finally {
        await execute(['bootout', target]).catch(() => {});
        try {
          const record = runtimeSupervisorSchema.parse(
            readRuntimeJson(join(directory, 'supervisor.json')),
          );
          await execute(['bootout', `${record.domain}/${record.name}`]).catch(() => {});
        } finally {
          await waitFor(() => {
            const claim = acquireHostClaim(home, `runtime:${launch.identity.runtime_id}`);
            claim.release();
            return true;
          });
        }
      }
    },
  );
});
