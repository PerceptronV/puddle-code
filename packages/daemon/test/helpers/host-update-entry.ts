import { constants, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Pinned helper with real native claims, using fake systemctl commands on every test OS. */
export async function buildHostUpdateEntry(root: string) {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const entry = join(root, 'daemon/host-update.mjs');
  const node = join(root, 'bin/node');
  mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(node), { recursive: true, mode: 0o700 });
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
  writeFileSync(join(root, 'daemon/install.sh'), '');
  symlinkSync(join(repo, 'packages/daemon/node_modules'), join(root, 'daemon/node_modules'));
  await buildEntry(repo, entry, 'packages/daemon/src/updates/worker/index.ts');
  return { entry, node };
}

/** Real connector management entry alongside an already prepared pinned host helper. */
export async function buildHostConnectorEntry(root: string): Promise<void> {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  await buildEntry(repo, join(root, 'daemon/connector.mjs'), 'packages/connector/src/index.ts');
}

async function buildEntry(repo: string, entry: string, source: string): Promise<void> {
  await build({
    entryPoints: [join(repo, source)],
    outfile: entry,
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
    define: {
      __PUDDLED_VERSION__: '"0.4.0"',
      __PUDDLER_VERSION__: '"0.4.0"',
      __CONNECTOR_VERSION__: '"0.4.0"',
      'process.platform': '"linux"',
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}
