import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildNative } from '../../../scripts/build-native.mjs';
import { renderPrompt } from '../../../scripts/prompt-assets.mjs';

/** Actual shell/preloads, isolated state and a compile-time replacement host launcher. */
export async function buildNativePreview(directory, { transferFaults = false } = {}) {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const desktop = join(root, 'packages/desktop');
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    alias: {
      '@puddle-code/cli/lib': fileURLToPath(new URL('./preview-host.mjs', import.meta.url)),
      '@puddle/shared': join(root, 'packages/shared/src/index.ts'),
    },
    logLevel: 'warning',
  };
  const result = await build({
    ...common,
    entryPoints: [join(desktop, 'src/main.ts')],
    outfile: join(directory, 'main.mjs'),
    format: 'esm',
    metafile: true,
    banner: {
      js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);",
    },
  });
  assert.ok(!Object.keys(result.metafile.inputs).some((path) => /packages\/cli\//.test(path)));
  await build({
    ...common,
    entryPoints: ['preload', 'picker-preload', 'prompt-preload', 'auth-preload'].map((name) =>
      join(desktop, `src/${name}.ts`),
    ),
    outdir: directory,
    outExtension: { '.js': '.cjs' },
    format: 'cjs',
  });
  for (const name of ['host-picker', 'connect-prompt', 'ssh-auth-prompt'])
    await writeFile(join(directory, `${name}.html`), renderPrompt(name));
  buildNative(directory);
  await mkdir(join(directory, 'home'));
  if (transferFaults)
    await copyFile(
      new URL('./transfers/ipc-faults.mjs', import.meta.url),
      join(directory, 'transfer-faults.mjs'),
    );
  await writeFile(
    join(directory, 'entry.cjs'),
    `const { app, ipcMain } = require('electron');
app.setPath('userData', require('node:path').join(__dirname, 'profile'));
async function start() {
${transferFaults ? "  (await import('./transfer-faults.mjs')).installTransferFaults(ipcMain);" : ''}
  await import('./main.mjs');
}
start().catch(error => { console.error(error); app.exit(1); });
`,
  );
  // Exercise the real target-only migration on the first launch.
  await writeFile(
    join(directory, 'home/reopen-windows.json'),
    JSON.stringify({ targets: ['local'] }),
  );
}
