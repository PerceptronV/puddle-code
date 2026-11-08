import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { runtimeReleaseCapabilities, runtimeSupervisorSchema } from '@puddle/shared';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RuntimeLauncher } from '../../../src/runtime/lifecycle/launcher.js';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { huddleControlTarget } from '../../../src/runtime/huddle/controller/observations.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { HostMemoryLedger } from '../../../src/runtime/resources/host/ledger.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { bundleDir, children, environment } from '../../helpers/runtime-fixture.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';

const source = `import {HuddleNode} from 'puddlang/huddle'; import fs from 'node:fs';
export default HuddleNode({contract:'./node.json', async run({inputs}) {
fs.appendFileSync(inputs.value + '/entered', 'x');
while(!fs.existsSync(inputs.value + '/release')) await new Promise(r => setTimeout(r, 10));
return {completed: 42}; }});`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Huddle lifecycle observation timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fixture(loseDispatchReply = false) {
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

it('launches one pinned inactive owner, runs and interrupts it, then stops with a lost reply without redispatch', async () => {
  const f = await fixture(true);
  try {
    await f.launcher.launchHuddle(f.session.id, f.options);
    expect(f.run).toHaveBeenCalledTimes(1);
    const binding = f.runtimes.ownerOf(f.session.id)!;
    expect(binding.release_path).toBe(realpathSync(f.installed.release));
    const client = f.connections.getHuddle(binding.runtime_id)!;
    expect(client.state).toMatchObject({ executing: false, control: { state: 'stopped' } });
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
    await f.controls.huddles.arm(
      f.session.id,
      huddleControlTarget(client.state!),
      false,
      () => true,
    );
    const accepted = await f.controls.huddles.trigger(
      f.session.id,
      huddleControlTarget(client.state!),
      'run',
      'one',
      f.home,
      () => true,
    );
    await until(() => existsSync(join(f.home, 'entered')));
    expect(
      await f.controls.huddles.trigger(
        f.session.id,
        huddleControlTarget(client.state!),
        'run',
        'one',
        f.home,
        () => true,
      ),
    ).toEqual({ ...accepted, duplicate: true });
    await f.controls.huddles.interrupt(
      f.session.id,
      huddleControlTarget(client.state!),
      () => true,
    );
    expect(f.sessions.get(f.session.id).status).toBe('interrupted');
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    runtimeRelease(f.home, '1.0.0').select();
    const request = client.request.bind(client);
    const requests = vi.spyOn(client, 'request').mockImplementation(async (command) => {
      const response = await request(command);
      if (command.t === 'shutdown') throw new RuntimeConnectionLost();
      return response;
    });
    await f.controls.huddles.stop(f.session.id, () => true);
    expect(requests.mock.calls.filter(([r]) => r.t === 'shutdown')).toHaveLength(1);
    expect(f.runtimes.stopRequested(binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(binding.runtime_id)?.state).toBe('exited');
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    expect(f.runtimes.hasUnreleasedHuddle(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});

it('rejects unsupported selection, revoked authority and malformed activation before recording owner intent', async () => {
  const f = await fixture();
  try {
    const before = readdirSync(join(f.home, 'runtimes')).sort();
    const old = runtimeRelease(f.home, '1.0.0');
    old.select();
    await expect(f.launcher.launchHuddle(f.session.id, f.options)).rejects.toThrow(
      /huddle capability/,
    );
    f.installed.select();
    await expect(
      f.launcher.launchHuddle(f.session.id, { ...f.options, authorised: () => false }),
    ).rejects.toMatchObject({ code: 'upstream_expired' });
    await expect(
      f.launcher.launchHuddle(f.session.id, {
        ...f.options,
        bindings: { absent: { worktree: f.home } },
      }),
    ).rejects.toThrow(/unknown node/);
    await expect(
      f.launcher.launchHuddle(f.session.id, { ...f.options, beforeLaunch: () => old.select() }),
    ).rejects.toThrow(/huddle capability/);
    expect(f.runtimes.ownerOf(f.session.id)).toBeNull();
    expect(readdirSync(join(f.home, 'runtimes')).sort()).toEqual(before);
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('preserves consumed Stop and refuses queued work after authority revocation', async () => {
  const f = await fixture();
  try {
    await f.launcher.launchHuddle(f.session.id, f.options);
    const binding = f.runtimes.ownerOf(f.session.id)!;
    const client = f.connections.getHuddle(binding.runtime_id)!;
    const request = client.request.bind(client);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = vi.spyOn(client, 'request').mockImplementation(async (command) => {
      if (command.t === 'inspect') await held;
      return request(command);
    });
    const inspect = f.controls.huddles.inspect(f.session.id, () => true);
    let authorised = true;
    const arm = f.controls.huddles.arm(
      f.session.id,
      huddleControlTarget(client.state!),
      false,
      () => authorised,
    );
    const rejected = expect(arm).rejects.toMatchObject({ code: 'upstream_expired' });
    authorised = false;
    release();
    await inspect;
    await rejected;
    expect(calls.mock.calls.some(([r]) => r.t === 'arm')).toBe(false);
    calls.mockRestore();
    // Simulate a previous consumed shutdown whose acknowledgement was lost.
    expect(f.runtimes.requestHuddleStop(binding.runtime_id, f.session.id)).toBe(true);
    expect(f.runtimes.requestHuddleStop(binding.runtime_id, f.session.id)).toBe(false);
    const stopping = f.controls.huddles.stop(f.session.id, () => true);
    const observed = vi.spyOn(client, 'request');
    await request({ t: 'shutdown' });
    await stopping;
    expect(observed.mock.calls.some(([r]) => r.t === 'shutdown')).toBe(false);
  } finally {
    await f.close();
  }
});

it('retires a positively unconsumed memory-refused attempt without dispatching it', async () => {
  const f = await fixture();
  const memory = HostMemoryLedger.openExisting(f.home)!;
  try {
    const neighbour = {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
    };
    expect(memory.compareGrant(neighbour, 0, memory.capacityBytes)).not.toBeNull();
    await expect(f.launcher.launchHuddle(f.session.id, f.options)).rejects.toMatchObject({
      code: 'runtime_memory_unavailable',
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.runtimes.hasUnreleasedHuddle(f.session.id)).toBe(false);
    const binding = f.db.prepare("SELECT * FROM runtime_bindings WHERE role = 'huddle'").get() as {
      runtime_id: string;
      state: string;
    };
    expect(binding.state).toBe('exited');
    expect(existsSync(join(f.home, 'runtimes', binding.runtime_id, 'retired.json'))).toBe(true);
    expect(existsSync(join(f.home, 'runtimes', binding.runtime_id, 'consumed.json'))).toBe(false);
  } finally {
    memory.close();
    await f.close();
  }
});
