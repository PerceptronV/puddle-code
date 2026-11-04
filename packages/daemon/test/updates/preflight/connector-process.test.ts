import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { HostUpdateConnector } from '../../../src/updates/preflight/connector.js';

it('inspects an actual bundled connector through its pinned Node and release metadata', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-pinned-connector-')));
  const root = join(home, 'bin/versions/0.4.0~fixture');
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
  const entry = join(root, 'daemon/connector.mjs');
  const node = join(root, 'bin/node');
  const environment = {
    HOME: home,
    PUDDLE_HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(dirname(node), { recursive: true });
    copyFileSync(process.execPath, node);
    symlinkSync(join(repo, 'packages/connector/node_modules'), join(root, 'daemon/node_modules'));
    await build({
      entryPoints: [join(repo, 'packages/connector/src/index.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
      alias: {
        '@puddle/shared/node/host-control': join(repo, 'packages/shared/src/node/host-control.ts'),
        '@puddle/shared/node': join(repo, 'packages/shared/src/node/security.ts'),
        '@puddle/shared': join(repo, 'packages/shared/src/index.ts'),
        '@puddle/remote-transport': join(repo, 'packages/remote-transport/src/index.ts'),
      },
      define: { __CONNECTOR_VERSION__: JSON.stringify('0.4.0') },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const capabilities = hostReleaseCapabilities('0.4.0');
    writeFileSync(join(root, 'HOST_CAPABILITIES.json'), JSON.stringify(capabilities), {
      mode: 0o644,
    });
    const smoke = await promisify(execFile)(node, [entry, '--version'], {
      env: environment,
      timeout: 10_000,
    });
    expect(smoke.stdout).toContain(`remote protocol ${capabilities.remote}`);
    const operation = new HostUpdateOperations(home).begin([
      { component: 'daemon', version: '0.4.0' },
    ]).operation;
    const inspector = new HostUpdateConnector(home, home);
    child = spawn(node, [entry], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-4096);
    });
    await expect
      .poll(
        async () => {
          if (child!.exitCode !== null || child!.signalCode !== null)
            throw new Error(`Fixture connector exited: ${errors}`);
          return (await inspector.inspect(operation)).state;
        },
        { timeout: 10_000 },
      )
      .toBe('running');
    const first = await inspector.inspect(operation);
    expect(first.identity).toMatchObject({
      pid: child.pid,
      version: '0.4.0',
      application: capabilities.application,
      remote: capabilities.remote,
      node_path: node,
      entry_path: entry,
      release_path: root,
    });
    expect(await inspector.inspect(operation)).toEqual(first);
    writeFileSync(
      join(root, 'HOST_CAPABILITIES.json'),
      JSON.stringify({ ...capabilities, remote: capabilities.remote + 1 }),
    );
    expect((await inspector.inspect(operation)).state).toBe('unknown');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      const kill = setTimeout(() => child?.kill('SIGKILL'), 2000);
      child.kill('SIGTERM');
      try {
        await exited;
      } finally {
        clearTimeout(kill);
      }
    }
    // Never remove an executable tree while its fixture process may still be live.
    rmSync(dirname(ipcPath(home, 'remote')), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
