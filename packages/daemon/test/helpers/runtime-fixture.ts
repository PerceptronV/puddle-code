import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { runtimeStateSchema, type RuntimeLaunch, type RuntimeState } from '@puddle/shared';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/transport/client.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
  runtimeDirectory,
} from '../../src/runtime/ownership/storage.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export let bundleDir: string;
export const children: ChildProcess[] = [];
const homes: string[] = [];
export const clients: RuntimeClient[] = [];
export const controllers: ReturnType<typeof acquireRuntimeController>[] = [];
const socketDirectories = new Set<string>();

beforeAll(async () => {
  // Stage like a host release outside privacy-sensitive checkout directories.
  // launchd must not need Desktop/Documents access to read the test executable.
  bundleDir = mkdtempSync(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-runtime-bundle-'),
  );
  const require = createRequire(join(packageRoot, 'package.json'));
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: true });
  };
  for (const name of ['node-pty', 'better-sqlite3']) {
    const root = dirname(require.resolve(`${name}/package.json`));
    const target = join(bundleDir, 'node_modules', name);
    copy(join(root, 'lib'), join(target, 'lib'));
    copy(join(root, 'package.json'), join(target, 'package.json'));
    for (const directory of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
      if (existsSync(join(root, directory))) copy(join(root, directory), join(target, directory));
    }
  }
  const nativeRequire = createRequire(require.resolve('better-sqlite3/package.json'));
  for (const name of ['bindings', 'file-uri-to-path']) {
    copy(
      dirname(nativeRequire.resolve(`${name}/package.json`)),
      join(bundleDir, 'node_modules', name),
    );
  }
  await build({
    entryPoints: {
      puddler: join(packageRoot, 'src/runtime/index.ts'),
      controller: join(packageRoot, 'test/helpers/runtime-controller.ts'),
      'provider-owner': join(packageRoot, 'test/helpers/runtime-provider-owner.ts'),
      'fake-codex': join(packageRoot, 'test/helpers/runtime-codex.ts'),
      'daemon-owner': join(packageRoot, 'test/helpers/runtime-daemon.ts'),
    },
    outdir: bundleDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    external: ['node-pty', 'better-sqlite3'],
    platform: 'node',
    format: 'esm',
    alias: {
      '@puddle/shared/node': fileURLToPath(
        new URL('../../../shared/src/node/security.ts', import.meta.url),
      ),
      '@puddle/shared': fileURLToPath(new URL('../../../shared/src/index.ts', import.meta.url)),
    },
    define: { __PUDDLER_VERSION__: JSON.stringify('runtime-test') },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ type: 'module' }));
  await build({
    entryPoints: ['runner', 'runtime-api', 'zod'].map((name) =>
      join(packageRoot, `src/puddlang/${name}.ts`),
    ),
    outdir: bundleDir,
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: {
      '@puddle/shared': fileURLToPath(new URL('../../../shared/src/index.ts', import.meta.url)),
    },
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const controller of controllers.splice(0)) controller.release();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const directory of socketDirectories) rmSync(directory, { recursive: true, force: true });
  socketDirectories.clear();
});

export function environment(home: string): NodeJS.ProcessEnv {
  // Deliberately do not inherit the coding agent's orchestration variables.
  return { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
}
export function launchOwner(home: string, id: string, entry = 'puddler.mjs', path?: string) {
  socketDirectories.add(dirname(ipcPath(home, `runtime:${id}`)));
  const child = spawn(process.execPath, [join(bundleDir, entry), '--home', home, '--runtime', id], {
    env: { ...environment(home), ...(path ? { PATH: path } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  return { child, errors: () => errors };
}
export function prepare(provider?: 'interactive' | 'headless') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-runtime-host-'));
  homes.push(home);
  const controller = acquireRuntimeController(home);
  controllers.push(controller);
  const launch: RuntimeLaunch = {
    format: 1,
    identity: {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: '1111111111',
      project_id: '2222222222',
      session_id: randomUUID(),
      canonical_worktree_path: home,
    },
    secret: randomBytes(32).toString('hex'),
    main: {
      file: '/bin/sh',
      args: [],
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', PS1: 'runtime> ' },
      cols: 80,
      rows: 24,
    },
    ...(provider
      ? {
          provider: {
            id: 'runtime-test',
            config_dir: home,
            mode: provider,
            skip_permissions: false,
          },
        }
      : {}),
  };
  const directory = runtimeDirectory(home, launch.identity.runtime_id);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  socketDirectories.add(dirname(ipcPath(home, `runtime:${launch.identity.runtime_id}`)));
  return { home, launch, controller, directory };
}
export async function setup(provider?: 'interactive' | 'headless') {
  const { home, launch, controller, directory } = prepare(provider);
  const owner = launchOwner(
    home,
    launch.identity.runtime_id,
    provider ? 'provider-owner.mjs' : 'puddler.mjs',
  );
  await waitForOwner(owner, directory);
  const client = await RuntimeClient.open(home, launch, controller.record);
  clients.push(client);
  return { home, launch, controller, client, directory, owner };
}
export async function waitForOwner(owner: ReturnType<typeof launchOwner>, directory: string) {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const state = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
      if (state.state === 'running') break;
    } catch {
      /* Wait for the isolated runtime's initial state. */
    }
    if (owner.child.exitCode !== null || Date.now() > deadline)
      throw new Error(`Runtime did not start: ${owner.errors()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export function terminal(state: RuntimeState | null) {
  const term = state?.terminals.find((item) => item.term === 'agent');
  if (!term) throw new Error('Runtime omitted main terminal');
  return term;
}
export async function waitForSnapshot(
  client: RuntimeClient,
  generation: string,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await client.request({
      t: 'snapshot',
      term: 'agent',
      generation,
    });
    if (response.t === 'snapshot' && response.data.includes(expected)) return response.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Terminal did not contain ${expected}`);
}
