#!/usr/bin/env node
/**
 * Builds the self-contained puddled release tarball for the CURRENT platform
 * (SPEC §10 "Distribution and bootstrap"). Deliberately no --platform flag:
 * native modules must never be cross-compiled, so each platform's tarball is
 * built on a machine (CI runner) of that platform, where `pnpm install` has
 * just produced correct binaries.
 *
 *   node scripts/build-tarball.mjs [--version X.Y.Z] [--out-dir dist-release] [--stage-only]
 *
 * Tarball tree (~27-34 MB gz; the pinned Node binary is >95% of it):
 *   puddled-v<v>/
 *   ├── puddled            # sh launcher: exec bin/node daemon/puddled.mjs "$@"
 *   ├── VERSION
 *   ├── LICENSE
 *   ├── bin/node           # pinned runtime, nothing else from the Node dist
 *   └── daemon/
 *       ├── puddled.mjs    # esbuild bundle (daemon + shared + hono + ws + zod + yazl)
 *       └── node_modules/  # pruned node-pty, better-sqlite3, bindings, file-uri-to-path
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Single source of truth for the runtime shipped in every tarball. */
const NODE_RUNTIME_VERSION = '22.21.1';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const version =
  flag('--version') ??
  JSON.parse(readFileSync(join(repoRoot, 'packages/daemon/package.json'), 'utf8')).version;
const outDir = resolve(repoRoot, flag('--out-dir') ?? 'dist-release');
const stageOnly = args.includes('--stage-only');

const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  fail(`unsupported build platform ${process.platform}: tarballs target linux and darwin only`);
}
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const target = `${platform}-${arch}`;
const name = `puddled-v${version}-${target}`;
const stage = join(outDir, 'stage', `puddled-v${version}`);

function fail(message) {
  console.error(`build-tarball: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`build-tarball: ${message}`);
}

/* 1 — bundle the daemon (+ @puddle/shared from source) into one ESM file. */
async function bundleDaemon() {
  mkdirSync(join(stage, 'daemon'), { recursive: true });
  await build({
    entryPoints: [join(repoRoot, 'packages/daemon/src/index.ts')],
    outfile: join(stage, 'daemon', 'puddled.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Native modules stay external (shipped pruned in daemon/node_modules);
    // ws's optional accelerators must stay unresolved requires it can catch.
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    alias: { '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts') },
    define: { __PUDDLED_VERSION__: JSON.stringify(version) },
    // Bundled CJS deps keep guarded `require(...)` calls (ws's optional
    // natives); in an ESM bundle `require` must exist for them to fail softly.
    banner: {
      js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
    },
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });
  log(`bundled daemon (${(statSync(join(stage, 'daemon', 'puddled.mjs')).size / 1e6).toFixed(1)} MB)`);
}

/* 2 — copy the two native packages, pruned to their runtime shape. */
function copyNativePackages() {
  const req = createRequire(join(repoRoot, 'packages/daemon/package.json'));
  const dest = join(stage, 'daemon', 'node_modules');

  const pkgRoot = (spec) => dirname(req.resolve(`${spec}/package.json`));

  // node-pty: lib/*.js + package.json + whichever of build/Release (node-gyp,
  // Linux) or prebuilds/<target> (darwin) exists. Loader probes both
  // (lib/utils.js), so this stays correct if Linux prebuilds appear later.
  const pty = pkgRoot('node-pty');
  const ptyDest = join(dest, 'node-pty');
  copyFiltered(join(pty, 'lib'), join(ptyDest, 'lib'), (p) => {
    return !p.endsWith('.js.map') && !p.endsWith('.test.js');
  });
  cpSync(join(pty, 'package.json'), join(ptyDest, 'package.json'));
  const ptyBuild = join(pty, 'build', 'Release');
  const ptyPrebuild = join(pty, 'prebuilds', target);
  if (existsSync(ptyBuild)) {
    cpSync(ptyBuild, join(ptyDest, 'build', 'Release'), { recursive: true, dereference: true });
  } else if (existsSync(ptyPrebuild)) {
    cpSync(ptyPrebuild, join(ptyDest, 'prebuilds', target), {
      recursive: true,
      dereference: true,
    });
  } else {
    fail(`node-pty has neither build/Release nor prebuilds/${target} — run pnpm install here`);
  }
  // The spawn-helper must stay executable (see scripts/fix-node-pty-perms.mjs).
  for (const dir of [join(ptyDest, 'build', 'Release'), join(ptyDest, 'prebuilds', target)]) {
    const helper = join(dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }

  // better-sqlite3: lib + the compiled binding; deps/ (9.8 MB of sqlite
  // source) and src/ are build-time only.
  const bs3 = pkgRoot('better-sqlite3');
  const bs3Dest = join(dest, 'better-sqlite3');
  cpSync(join(bs3, 'lib'), join(bs3Dest, 'lib'), { recursive: true, dereference: true });
  cpSync(join(bs3, 'package.json'), join(bs3Dest, 'package.json'));
  const bs3Node = join(bs3, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(bs3Node)) {
    fail('better-sqlite3 has no build/Release/better_sqlite3.node — run pnpm install here');
  }
  mkdirSync(join(bs3Dest, 'build', 'Release'), { recursive: true });
  cpSync(bs3Node, join(bs3Dest, 'build', 'Release', 'better_sqlite3.node'));

  // bindings (better-sqlite3's runtime loader) and its one dependency, whole.
  const bindingsReq = createRequire(join(bs3, 'package.json'));
  for (const small of ['bindings', 'file-uri-to-path']) {
    cpSync(dirname(bindingsReq.resolve(`${small}/package.json`)), join(dest, small), {
      recursive: true,
      dereference: true,
    });
  }
  log('copied pruned native packages');
}

function copyFiltered(from, to, keep) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyFiltered(src, dst, keep);
    else if (keep(src)) cpSync(src, dst, { dereference: true });
  }
}

/* 3 — fetch (cached) the pinned Node runtime; ship only bin/node. */
async function fetchNodeRuntime() {
  const cacheDir = join(repoRoot, 'node_modules', '.cache', 'puddle-node-runtime');
  const distName = `node-v${NODE_RUNTIME_VERSION}-${target}`;
  const cachedNode = join(cacheDir, distName, 'bin', 'node');

  if (!existsSync(cachedNode)) {
    mkdirSync(cacheDir, { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
    const tarName = `${distName}.tar.gz`;
    const tarPath = join(cacheDir, tarName);
    log(`downloading ${base}/${tarName}`);
    const res = await fetch(`${base}/${tarName}`);
    if (!res.ok || res.body === null) fail(`node download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));

    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const expected = sums
      .split('\n')
      .find((line) => line.endsWith(`  ${tarName}`))
      ?.split(/\s+/)[0];
    if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${tarName}`);
    const actual = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
    if (actual !== expected) fail(`checksum mismatch for ${tarName}`);

    execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir, `${distName}/bin/node`]);
    rmSync(tarPath);
  }

  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(cachedNode, join(stage, 'bin', 'node'));
  chmodSync(join(stage, 'bin', 'node'), 0o755);
  log(`staged node v${NODE_RUNTIME_VERSION} (${(statSync(cachedNode).size / 1e6).toFixed(0)} MB)`);
}

/* 4 — launcher, VERSION, LICENSE. */
function writeMetadata() {
  // dirname of ~/.puddle/bin/current/puddled resolves THROUGH the `current`
  // symlink, so bin/node is found without readlink -f. install.sh writes
  // ~/.puddle/bin/puddled as an exec wrapper (never a symlink) for this reason.
  writeFileSync(
    join(stage, 'puddled'),
    '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/daemon/puddled.mjs" "$@"\n',
  );
  chmodSync(join(stage, 'puddled'), 0o755);
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  cpSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));
}

/* 5 — smoke test: a broken bundle, missing banner, or wrong-ABI native dies here. */
function smokeTest() {
  const out = execFileSync(join(stage, 'puddled'), ['--version'], { encoding: 'utf8' });
  if (!out.startsWith(`puddled ${version} `)) {
    fail(`smoke test failed: unexpected --version output ${JSON.stringify(out)}`);
  }
  log(`smoke test passed: ${out.trim()}`);
}

/* 6 — tar + checksum. */
function pack() {
  const tarball = join(outDir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', join(outDir, 'stage'), `puddled-v${version}`], {
    // Prevents AppleDouble ._* entries in tarballs built on macOS.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  // sha256sum -c compatible: "<hex>  <filename>".
  writeFileSync(`${tarball}.sha256`, `${digest}  ${name}.tar.gz\n`);
  log(`wrote ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)} MB)`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await bundleDaemon();
copyNativePackages();
await fetchNodeRuntime();
writeMetadata();
smokeTest();
if (!stageOnly) pack();
