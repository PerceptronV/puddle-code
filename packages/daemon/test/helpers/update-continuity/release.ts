import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  hostReleaseCapabilities,
  PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
} from '@puddle/shared';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { bundleDir } from '../runtime-fixture.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
export const installer = join(repo, 'scripts/install.sh');

/**
 * Actual management/runtime bundles and native dependencies in a checked host archive.
 * Both synthetic versions use current source: this proves upgrade composition,
 * not migration from an historical released daemon or native systemd behaviour.
 */
export async function continuityRelease(
  home: string,
  version: string,
  native = false,
  entries?: { puddled: string; puddler: string },
) {
  const root = join(home, 'test-archives', version);
  const release = join(root, `puddled-v${version}`);
  mkdirSync(join(release, 'bin'), { recursive: true });
  copyFileSync(process.execPath, join(release, 'bin/node'), constants.COPYFILE_FICLONE);
  cpSync(join(bundleDir, 'node_modules'), join(release, 'node_modules'), { recursive: true });
  await build({
    entryPoints: {
      puddled: entries?.puddled ?? join(repo, 'packages/daemon/src/index.ts'),
      puddler: entries?.puddler ?? join(repo, 'packages/daemon/src/runtime/index.ts'),
      'host-update': join(repo, 'packages/daemon/src/updates/worker/index.ts'),
    },
    outdir: join(release, 'daemon'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    alias: {
      '@puddle/shared/node/host-control': join(repo, 'packages/shared/src/node/host-control.ts'),
      '@puddle/shared/node': join(repo, 'packages/shared/src/node/security.ts'),
      '@puddle/shared': join(repo, 'packages/shared/src/index.ts'),
    },
    // Exercise systemd command composition through the isolated executable fixture
    // on every test OS. Native modules retain the actual host platform.
    define: {
      __PUDDLED_VERSION__: JSON.stringify(version),
      __PUDDLER_VERSION__: JSON.stringify(version),
      ...(native ? {} : { 'process.platform': '"linux"' }),
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  copyFileSync(installer, join(release, 'daemon/install.sh'));
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const environment = native
    ? `/usr/bin/env -i ${['HOME=' + home, 'PUDDLE_HOME=' + home, 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'LANG=en_US.UTF-8', 'SHELL=/bin/sh'].map(quote).join(' ')} `
    : '';
  for (const component of ['puddled', 'puddler'])
    writeFileSync(
      join(release, component),
      `#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec ${environment}"$root/bin/node" "$root/daemon/${component}.mjs" "$@"\n`,
      { mode: 0o755 },
    );
  writeFileSync(join(release, 'VERSION'), version + '\n');
  writeFileSync(join(release, 'PROTOCOL'), `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}\n`);
  writeFileSync(
    join(release, 'RUNTIME_PROTOCOL'),
    `${RUNTIME_PROTOCOL_VERSION.major}.${RUNTIME_PROTOCOL_VERSION.minor}\n`,
  );
  writeFileSync(
    join(release, 'HOST_CAPABILITIES.json'),
    JSON.stringify(hostReleaseCapabilities(version, DATABASE_SCHEMA_VERSION)),
  );
  const archive = join(root, 'release.tar.gz');
  await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', root, `puddled-v${version}`]);
  writeFileSync(
    `${archive}.sha256`,
    `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  release.tar.gz\n`,
  );
  return archive;
}

export async function continuitySupervisor(home: string) {
  const directory = join(home, 'test-services');
  mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, 'systemctl');
  await build({
    entryPoints: [join(repo, 'packages/daemon/test/helpers/update-continuity/supervisor.ts')],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: `#!${process.execPath}` },
    logLevel: 'warning',
  });
  chmodSync(file, 0o700);
  return {
    HOME: home,
    PUDDLE_HOME: home,
    PATH: `${directory}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
  };
}
