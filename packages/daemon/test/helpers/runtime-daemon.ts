import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeSupervisorSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { startDaemon } from '../../src/daemon.js';
import { readRuntimeJson } from '../../src/runtime/storage.js';
import type { RuntimeLaunchConfiguration } from '../../src/runtime/launcher.js';
import { runtimeTestAdapter, runtimePresetTestAdapter } from './runtime-test-adapter.js';

// Only the isolated test home and sanitised fixture environment are used.
const home = process.argv[3]!;
const bundle = dirname(fileURLToPath(import.meta.url));
const runtime: RuntimeLaunchConfiguration | undefined = existsSync(
  join(home, 'test-enable-runtime-launcher'),
)
  ? {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath: join(bundle, 'provider-owner.mjs'),
      releasePath: bundle,
      build: 'runtime-test',
      // Deterministic independent lifetime, not evidence of native supervisor behaviour.
      run: async (command) => {
        const directory = dirname(command.args[2]!);
        const record = runtimeSupervisorSchema.parse(
          readRuntimeJson(join(directory, 'supervisor.json')),
        );
        if (existsSync(join(home, 'test-hold-runtime-dispatch'))) {
          atomicPrivateJson(join(home, 'test-runtime-dispatch-pending.json'), {
            runtime_id: record.identity.runtime_id,
          });
          const deadline = Date.now() + 10_000;
          while (existsSync(join(home, 'test-hold-runtime-dispatch')) && Date.now() < deadline)
            await delay(25);
        }
        const child = spawn(
          record.node_path,
          [record.entry_path, '--home', home, '--runtime', record.identity.runtime_id],
          {
            env: process.env,
            stdio: 'ignore',
            detached: true,
          },
        );
        await once(child, 'spawn');
        atomicPrivateJson(join(directory, 'test-supervisor-pid.json'), { pid: child.pid });
        child.unref();
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }
  : undefined;
const daemon = await startDaemon({
  home,
  port: 0,
  adapters: [runtimeTestAdapter, runtimePresetTestAdapter],
  runtime,
});
const lease = daemon.authority.create();
atomicPrivateJson(join(home, 'test-daemon-ready.json'), { port: daemon.port, token: lease.token });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().then(() => process.exit(0));
  });
