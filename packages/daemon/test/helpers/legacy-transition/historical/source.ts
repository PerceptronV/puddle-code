import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { bundleDir } from '../../runtime-fixture.js';

export const HISTORICAL_COMMIT = 'c33cdeef3a5df58badf73c3dd74cee8dca23bdbe';
const LOCK_SHA256 = '6ef048108961fecd29cc3985e2796a003421c49cae073cbd85e8d1b9344312e2';
export const repository = fileURLToPath(new URL('../../../../../../', import.meta.url));
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);

/** Opt-in reconstruction of actual released source, not current source with an old label. */
export async function historicalRelease(directory: string) {
  const checkout = join(directory, 'historical-source');
  mkdirSync(checkout, { recursive: true });
  try {
    await execute('git', ['cat-file', '-e', `${HISTORICAL_COMMIT}^{commit}`], { cwd: repository });
  } catch {
    throw new Error(
      `Historical acceptance needs retained Git object ${HISTORICAL_COMMIT} (v0.3.14); fetch that history explicitly before running it`,
    );
  }
  const sourceArchive = join(directory, 'historical-source.tar');
  await execute(
    'git',
    [
      'archive',
      '--format=tar',
      '--output',
      sourceArchive,
      HISTORICAL_COMMIT,
      'packages/daemon/src',
      'packages/shared/src',
      'packages/daemon/package.json',
      'packages/shared/package.json',
      'pnpm-lock.yaml',
      'scripts/install.sh',
    ],
    { cwd: repository },
  );
  await execute('/usr/bin/tar', ['-xf', sourceArchive, '-C', checkout]);
  for (const file of [join(checkout, 'pnpm-lock.yaml'), join(repository, 'pnpm-lock.yaml')])
    if (digest(readFileSync(file)) !== LOCK_SHA256)
      throw new Error(
        'Historical acceptance requires the pinned v0.3.14 dependency lockfile; review dependency reconstruction before updating this gate',
      );
  const protocol = readFileSync(join(checkout, 'packages/shared/src/protocol.ts'), 'utf8');
  if (!/PROTOCOL_VERSION = \{ major: 25, minor: 6 \}/.test(protocol))
    throw new Error('Historical protocol provenance changed');
  const stage = join(directory, 'historical-stage');
  const release = join(stage, 'puddled-v0.3.14');
  mkdirSync(join(release, 'bin'), { recursive: true });
  cpSync(join(bundleDir, 'node_modules'), join(release, 'node_modules'), { recursive: true });
  const nativeVersions = { 'node-pty': '1.1.0', 'better-sqlite3': '12.11.1' };
  for (const [name, expected] of Object.entries(nativeVersions)) {
    const installed = JSON.parse(
      readFileSync(join(release, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version: string };
    if (installed.version !== expected)
      throw new Error(`Historical native dependency ${name} differs from the pinned release lock`);
  }
  copyFileSync(process.execPath, join(release, 'bin/node'), constants.COPYFILE_FICLONE);
  const controlEntry = join(checkout, 'historical-control.ts');
  writeFileSync(
    controlEntry,
    "export { HostControlClient } from './packages/shared/src/node/host-control.js';\n",
  );
  const result = await build({
    entryPoints: { puddled: join(checkout, 'packages/daemon/src/index.ts'), control: controlEntry },
    outdir: join(release, 'daemon'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    metafile: true,
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    nodePaths: [
      join(repository, 'packages/daemon/node_modules'),
      join(repository, 'packages/shared/node_modules'),
      join(repository, 'node_modules'),
    ],
    alias: {
      '@puddle/shared/node/host-control': join(
        checkout,
        'packages/shared/src/node/host-control.ts',
      ),
      '@puddle/shared/node': join(checkout, 'packages/shared/src/node/security.ts'),
      '@puddle/shared': join(checkout, 'packages/shared/src/index.ts'),
    },
    define: { __PUDDLED_VERSION__: '"0.3.14"' },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  const inputs = Object.keys(result.metafile.inputs).map((file) => resolve(file));
  for (const input of inputs)
    if (/\/packages\/(daemon|shared)\/src\//.test(input) && !input.startsWith(checkout + '/'))
      throw new Error(`Historical build imported current application source: ${input}`);
  writeFileSync(
    join(release, 'puddled'),
    '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/bin/node" "$root/daemon/puddled.mjs" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(release, 'VERSION'), '0.3.14\n');
  writeFileSync(join(release, 'PROTOCOL'), '25.6\n');
  const archive = join(directory, 'historical-release.tar.gz');
  await execute('/usr/bin/tar', ['-czf', archive, '-C', stage, 'puddled-v0.3.14']);
  writeFileSync(
    `${archive}.sha256`,
    `${digest(readFileSync(archive))}  historical-release.tar.gz\n`,
  );
  writeFileSync(
    join(directory, 'historical-provenance.json'),
    JSON.stringify(
      {
        commit: HISTORICAL_COMMIT,
        version: '0.3.14',
        protocol: '25.6',
        schema: 28,
        lock_sha256: LOCK_SHA256,
        source_archive_sha256: digest(readFileSync(sourceArchive)),
        daemon_sha256: digest(readFileSync(join(release, 'daemon/puddled.mjs'))),
        node: process.version,
        native_versions: nativeVersions,
        platform: process.platform,
        arch: process.arch,
        reconstruction:
          'Released source and locked dependencies; current host native modules, not the published release archive',
        application_inputs: inputs
          .filter((file) => file.startsWith(checkout + '/'))
          .map((file) => file.slice(checkout.length + 1))
          .sort(),
      },
      null,
      2,
    ),
  );
  return {
    archive,
    installer: join(checkout, 'scripts/install.sh'),
    control: join(release, 'daemon/control.mjs'),
  };
}
