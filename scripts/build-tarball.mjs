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
 * Tarball tree (size depends on the platform and pinned Node binary):
 *   puddled-v<v>/
 *   ├── puddled            # sh launcher: exec bin/node daemon/puddled.mjs "$@"
 *   ├── puddler            # same pinned Node/native dependencies, independent owner
 *   ├── VERSION
 *   ├── PROTOCOL           # exact major.minor, readable without executing puddled
 *   ├── CONNECTOR_PROTOCOL # remote protocol, display-only in the component inventory
 *   ├── RUNTIME_PROTOCOL   # private daemon/runtime major.minor
 *   ├── HOST_CAPABILITIES.json # passive protocol compatibility declaration
 *   ├── LICENSE
 *   ├── bin/node           # pinned runtime, nothing else from the Node dist
 *   └── daemon/
 *       ├── puddled.mjs    # esbuild bundle (daemon + shared + hono + ws + zod + yazl)
 *       ├── puddler.mjs    # independent runtime owner, from the same bundle configuration
 *       ├── host-update.mjs # bounded one-shot updater, using the canonical installer
 *       ├── install.sh     # the same embedded host installer used by CLI/desktop
 *       ├── host-control.mjs # private control relay and host-only legacy inspection
 *       └── node_modules/  # pruned node-pty, better-sqlite3, bindings, file-uri-to-path
 */
import { execFileSync } from 'node:child_process';
import { sha256File } from './lib/file-hash.mjs';
import {
  chmodSync,
  cpSync,
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
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { stageNodeRuntime } from './lib/node-runtime.mjs';
import { smokePuddlang } from './lib/puddlang-smoke.mjs';
import { readReleasePlan, legacyReleasePlan } from './lib/releases/plan.mjs';
import { releaseNotes } from './lib/releases/notes.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const version =
  flag('--version') ??
  JSON.parse(readFileSync(join(repoRoot, 'packages/daemon/package.json'), 'utf8')).version;
const notes = releaseNotes(repoRoot, version);
const protocolSource = readFileSync(join(repoRoot, 'packages/shared/src/protocol.ts'), 'utf8');
const protocolMatch = /PROTOCOL_VERSION\s*=\s*{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*}/.exec(
  protocolSource,
);
if (protocolMatch === null)
  fail('cannot read PROTOCOL_VERSION from packages/shared/src/protocol.ts');
const protocolVersion = `${protocolMatch[1]}.${protocolMatch[2]}`;
const connectorMatch = /REMOTE_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(join(repoRoot, 'packages/shared/src/remote/protocol.ts'), 'utf8'),
);
if (!connectorMatch) fail('cannot read REMOTE_PROTOCOL_VERSION');
const runtimeMatch = /RUNTIME_PROTOCOL_VERSION\s*=\s*{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*}/.exec(
  readFileSync(join(repoRoot, 'packages/shared/src/runtime/protocol.ts'), 'utf8'),
);
if (!runtimeMatch) fail('cannot read RUNTIME_PROTOCOL_VERSION');
const runtimeProtocol = `${runtimeMatch[1]}.${runtimeMatch[2]}`;
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

/* 1 — bundle host processes against the same pinned native packages. */
async function bundleHostProcesses() {
  mkdirSync(join(stage, 'daemon'), { recursive: true });
  await build({
    entryPoints: {
      puddled: join(repoRoot, 'packages/daemon/src/index.ts'),
      puddler: join(repoRoot, 'packages/daemon/src/runtime/index.ts'),
      'host-update': join(repoRoot, 'packages/daemon/src/updates/worker/index.ts'),
    },
    outdir: join(stage, 'daemon'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Native modules stay external (shipped pruned in daemon/node_modules);
    // ws's optional accelerators must stay unresolved requires it can catch.
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    alias: {
      '@puddle/shared/node/host-control': join(
        repoRoot,
        'packages/shared/src/node/host-control.ts',
      ),
      '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
      '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
    },
    define: {
      __PUDDLED_VERSION__: JSON.stringify(version),
      __PUDDLER_VERSION__: JSON.stringify(version),
      __PUDDLE_RELEASE_NOTES__: JSON.stringify(notes),
      ...(process.env.PUDDLE_REPO_SLUG
        ? { __PUDDLE_REPO_SLUG__: JSON.stringify(process.env.PUDDLE_REPO_SLUG) }
        : {}),
    },
    // Bundled CJS deps keep guarded `require(...)` calls (ws's optional
    // natives); in an ESM bundle `require` must exist for them to fail softly.
    banner: {
      js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
    },
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });
  for (const name of ['puddled', 'puddler', 'host-update'])
    log(
      `bundled ${name} (${(statSync(join(stage, 'daemon', `${name}.mjs`)).size / 1e6).toFixed(1)} MB)`,
    );
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

/* 4 — launcher, VERSION, PROTOCOL, LICENSE. */
function writeMetadata() {
  // dirname of ~/.puddle/bin/current/puddled resolves THROUGH the `current`
  // symlink, so bin/node is found without readlink -f. install.sh writes
  // ~/.puddle/bin/puddled as an exec wrapper (never a symlink) for this reason.
  for (const [name, entry] of [
    ['puddled', 'puddled'],
    ['puddler', 'puddler'],
    ['puddle-connector', 'connector'],
  ]) {
    writeFileSync(
      join(stage, name),
      `#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/daemon/${entry}.mjs" "$@"\n`,
    );
    chmodSync(join(stage, name), 0o755);
  }
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  const releasePlan = readReleasePlan(repoRoot, version);
  writeFileSync(join(stage, 'release-manifest-v2.json'), JSON.stringify(releasePlan) + '\n');
  writeFileSync(
    join(stage, 'release-manifest.json'),
    JSON.stringify(legacyReleasePlan(releasePlan)) + '\n',
  );
  if (notes !== null) writeFileSync(join(stage, 'RELEASE_NOTES.md'), notes);
  // Read directly by `puddle --version`; an offline inventory must never
  // execute an unknown historical daemon just to discover compatibility.
  writeFileSync(join(stage, 'PROTOCOL'), `${protocolVersion}\n`);
  writeFileSync(join(stage, 'CONNECTOR_PROTOCOL'), `${connectorMatch[1]}\n`);
  writeFileSync(join(stage, 'RUNTIME_PROTOCOL'), `${runtimeProtocol}\n`);
  cpSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));
  cpSync(join(repoRoot, 'scripts/install.sh'), join(stage, 'daemon/install.sh'));
  // Ask this newly built executable, never an unknown installed daemon. Consumers
  // read the bounded file without executing a candidate during update preflight.
  const capabilities = execFileSync(join(stage, 'puddled'), ['--host-capabilities'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 32 * 1024,
  });
  if (JSON.parse(capabilities).version !== version) fail('host capability version mismatch');
  writeFileSync(join(stage, 'HOST_CAPABILITIES.json'), capabilities);
}

/* 5 — smoke test: a broken bundle, missing banner, or wrong-ABI native dies here. */
function smokeTest() {
  const out = execFileSync(join(stage, 'puddled'), ['--version'], { encoding: 'utf8' });
  if (!out.startsWith(`puddled ${version} `)) {
    fail(`smoke test failed: unexpected --version output ${JSON.stringify(out)}`);
  }
  const connector = execFileSync(join(stage, 'puddle-connector'), ['--version'], {
    encoding: 'utf8',
  });
  if (!connector.startsWith('puddle-connector ')) fail('connector smoke test failed');
  const runtime = execFileSync(join(stage, 'puddler'), ['--version'], { encoding: 'utf8' });
  if (runtime.trim() !== `puddler ${version} (runtime protocol ${runtimeProtocol})`)
    fail('runtime smoke test failed');
  const updater = execFileSync(
    join(stage, 'bin/node'),
    [join(stage, 'daemon/host-update.mjs'), '--version'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 },
  );
  if (updater.trim() !== `puddle host updater ${version}`) fail('updater smoke test failed');
  log(`smoke test passed: ${out.trim()}; ${connector.trim()}; ${runtime.trim()}`);
}

/* 6 — tar + checksum. */
async function pack() {
  const tarball = join(outDir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', join(outDir, 'stage'), `puddled-v${version}`], {
    // Prevents AppleDouble ._* entries in tarballs built on macOS.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = await sha256File(tarball);
  // sha256sum -c compatible: "<hex>  <filename>".
  writeFileSync(`${tarball}.sha256`, `${digest}  ${name}.tar.gz\n`);
  log(`wrote ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)} MB)`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await bundleHostProcesses();
await build({
  entryPoints: ['runner', 'runtime-api', 'zod'].map((name) =>
    join(repoRoot, `packages/daemon/src/puddlang/${name}.ts`),
  ),
  outdir: join(stage, 'daemon'),
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  alias: { '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts') },
});
writeFileSync(join(stage, 'daemon/package.json'), JSON.stringify({ type: 'module' }));
await build({
  entryPoints: [join(repoRoot, 'packages/cli/src/host-control.ts')],
  outfile: join(stage, 'daemon/host-control.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  alias: {
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
  },
});
await build({
  entryPoints: [join(repoRoot, 'packages/connector/src/index.ts')],
  outfile: join(stage, 'daemon/connector.mjs'),
  define: { __CONNECTOR_VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  alias: {
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
    '@puddle/remote-transport': join(repoRoot, 'packages/remote-transport/src/index.ts'),
  },
  banner: {
    js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
  },
});
copyNativePackages();
await stageNodeRuntime(repoRoot, stage, target, log);
writeMetadata();
smokeTest();
await smokePuddlang(stage);
log('puddlang runner smoke test passed');
if (!stageOnly) await pack();
