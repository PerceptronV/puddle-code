#!/usr/bin/env node
/**
 * Builds the publishable CLI: one esbuild bundle (ws and @puddle/shared
 * inlined, so the published package has zero runtime dependencies), the
 * canonical install.sh beside it, and the built web UI under dist/public —
 * `npm i -g @puddle-code/cli` ships the whole cockpit (SPEC §2: UI updates
 * ride the CLI, hosts only update when the protocol breaks).
 */
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;

// Baked at release time from the publishing repository (release.yml exports
// PUDDLE_REPO_SLUG); absent in dev builds, where PUDDLE_REPO takes over.
const slug = process.env.PUDDLE_REPO_SLUG;

await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  outfile: join(pkgRoot, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['bufferutil', 'utf-8-validate'], // ws's optional accelerators
  alias: { '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts') },
  define: {
    __PUDDLE_CLI_VERSION__: JSON.stringify(version),
    ...(slug ? { __PUDDLE_REPO_SLUG__: JSON.stringify(slug) } : {}),
  },
  banner: {
    js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

cpSync(join(repoRoot, 'scripts/install.sh'), join(pkgRoot, 'dist/install.sh'));

const webDist = join(repoRoot, 'packages/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('cli build: packages/web/dist is missing — build the web package first');
  process.exit(1);
}
cpSync(webDist, join(pkgRoot, 'dist/public'), { recursive: true });
console.log(
  `cli build: dist/index.js + install.sh + public/ (v${version}${slug ? `, repo ${slug}` : ''})`,
);
