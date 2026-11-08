import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, copyFileSync, cpSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { vi } from 'vitest';
import { runtimeReleaseCapabilities, runtimeSupervisorSchema } from '@puddle/shared';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RuntimeLauncher } from '../../../src/runtime/lifecycle/launcher.js';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { runtimeDatabase } from '../runtime-database.js';
import { runtimeRelease } from '../runtime-release.js';
import { bundleDir, children, environment } from '../runtime-fixture.js';
import { schedulerSnapshot } from './scheduler.js';

const source = `import {HuddleNode} from 'puddlang/huddle'; import fs from 'node:fs';
export default HuddleNode({contract:'./node.json', async run({inputs}) {
fs.appendFileSync(inputs.value + '/entered', 'x');
while(!fs.existsSync(inputs.value + '/release')) await new Promise(r => setTimeout(r, 10));
return {completed: 42}; }});`;

export async function huddleLaunchFixture(loseDispatchReply = false) {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  const installed = runtimeRelease(f.home, '1.2.3', '1.1');
  copyFileSync(
    process.execPath,
    join(installed.release, 'bin', 'node'),
    constants.COPYFILE_FICLONE,
  );
  cpSync(bundleDir, join(installed.release, 'daemon'), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('../../../src/runtime/index.ts', import.meta.url))],
    outfile: join(installed.release, 'daemon', 'puddler.mjs'),
    bundle: true,
    external: ['node-pty', 'better-sqlite3'],
    platform: 'node',
    format: 'esm',
    define: { __PUDDLER_VERSION__: JSON.stringify('1.2.3') },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  writeFileSync(
    join(installed.release, 'RUNTIME_CAPABILITIES.json'),
    JSON.stringify(runtimeReleaseCapabilities('1.2.3')),
  );
  installed.select();
  const huddleId = randomBytes(16).toString('hex');
  const session = new HuddlePlacements(f.db).open({
    projectId: f.project.id,
    worktree: f.home,
    huddleId,
    branch: 'main',
    title: 'Lifecycle',
  }).session;
  const connections = new RuntimeConnections(
    f.home,
    f.runtimes,
    {
      connected: (id, client) => f.reconciler.attach(id, client),
      missing: (id) => f.reconciler.retire(id),
      huddleConnected: (id, client) => f.reconciler.attachHuddle(id, client),
      huddleMissing: (id) => f.reconciler.retire(id),
    },
    f.controller,
  );
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    const record = runtimeSupervisorSchema.parse(
      readRuntimeJson(join(dirname(command.args[2]!), 'supervisor.json')),
    );
    const child = spawn(
      record.node_path,
      [record.entry_path, '--home', f.home, '--runtime', record.identity.runtime_id],
      { env: environment(f.home), detached: true, stdio: 'ignore' },
    );
    children.push(child);
    await once(child, 'spawn');
    if (loseDispatchReply) throw new Error('Supervisor reply lost after acceptance');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const launcher = new RuntimeLauncher(
    {
      ...f,
      connections,
      projects: new ProjectStore(f.db),
      environment: environment(f.home) as Record<string, string>,
    },
    { installed: true, kind: 'launchd', run },
  );
  const controls = new RuntimeControls(f.runtimes, connections, f.reconciler);
  const options = {
    snapshot: schedulerSnapshot(huddleId, source),
    hostId: 'fixture',
    variables: {},
    bindings: {},
    authorised: () => true,
  };
  return {
    ...f,
    session,
    installed,
    connections,
    launcher,
    controls,
    run,
    options,
    async close() {
      await launcher.close();
      await controls.close();
      await connections.close();
      await f.reconciler.close();
      f.db.close();
    },
  };
}
