#!/usr/bin/env node
/** Prepare component publication before tagging. No network access or publishing side effects. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { validateReleasePlan } from './lib/releases/plan.mjs';
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const version = flag('--version');
const base = flag('--base');
const selection = flag('--components') ?? 'auto';
if (!version || !base || base.startsWith('-'))
  throw new Error(
    'Usage: node scripts/plan-release.mjs --version X.Y.Z --base vX.Y.Z [--components auto|all|cockpit,daemon,runtime]',
  );
const git = (...command) =>
  execFileSync('git', command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const root = git('rev-parse', '--show-toplevel');
const baseline = git('rev-parse', '--verify', `${base}^{commit}`);
const baseVersion = base.replace(/^v/, '');
let previous;
let previousText;
let transition = false;
try {
  previousText = git('show', `${baseline}:release-manifest.json`);
} catch {
  transition = true;
  previous = {
    format: 1,
    version: baseVersion,
    components: { cockpit: baseVersion, daemon: baseVersion, runtime: baseVersion },
  };
}
if (previousText !== undefined) previous = JSON.parse(previousText);
validateReleasePlan(previous, baseVersion);
const changesSince = (commit) =>
  [git('diff', '--name-only', commit, '--'), git('ls-files', '--others', '--exclude-standard')]
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .filter((path) => {
      if (!(
        path === 'package.json' || /^packages\/(daemon|shared|connector)\/package.json$/.test(path)
      ))
        return true;
      try {
        const before = JSON.parse(git('show', `${commit}:${path}`));
        const after = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
        delete before.version;
        delete after.version;
        return JSON.stringify(before) !== JSON.stringify(after);
      } catch {
        return true;
      }
    });
let selected;
if (selection === 'all') selected = new Set(['cockpit', 'daemon', 'runtime']);
else if (selection !== 'auto') {
  selected = new Set(selection.split(','));
  if (![...selected].every((name) => ['cockpit', 'daemon', 'runtime'].includes(name)))
    throw new Error('Unknown release component');
  selected.add('cockpit');
} else {
  selected = new Set(['cockpit']);
  // Analyse the actual shipped import closures, including shared source dependencies.
  const result = await build({
    absWorkingDir: root,
    entryPoints: {
      daemon: 'packages/daemon/src/index.ts',
      runtime: 'packages/daemon/src/runtime/index.ts',
      worker: 'packages/daemon/src/updates/worker/index.ts',
      connector: 'packages/connector/src/index.ts',
    },
    outdir: '/tmp/puddle-release-analysis',
    write: false,
    metafile: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    alias: {
      '@puddle/shared/node/host-control': resolve(root, 'packages/shared/src/node/host-control.ts'),
      '@puddle/shared/node': resolve(root, 'packages/shared/src/node/security.ts'),
      '@puddle/shared': resolve(root, 'packages/shared/src/index.ts'),
    },
    logLevel: 'silent',
  });
  const inputs = (name) =>
    new Set(
      Object.entries(result.metafile.outputs)
        .filter(([path]) => path.endsWith(`/${name}.js`))
        .flatMap(([, output]) =>
          Object.entries(output.inputs)
            .filter(([, input]) => input.bytesInOutput > 0)
            .map(([path]) => path),
        ),
    );
  const runtime = inputs('runtime');
  const daemon = new Set([...inputs('daemon'), ...inputs('worker'), ...inputs('connector')]);
  const sharedBuild = (path) =>
    path === 'pnpm-lock.yaml' ||
    path === 'pnpm-workspace.yaml' ||
    path === 'package.json' ||
    /^packages\/(daemon|shared|connector)\/package.json$/.test(path) ||
    path === 'scripts/build-tarball.mjs' ||
    path === 'scripts/install.sh' ||
    path.startsWith('scripts/lib/') ||
    path === '.github/workflows/release.yml' ||
    path.startsWith('packages/shared/src/runtime/') ||
    path.startsWith('packages/daemon/src/agents/') ||
    path.startsWith('packages/daemon/src/pty/') ||
    (path.startsWith('packages/daemon/src/') && /\.(py|sh)$/.test(path));
  for (const [component, closure] of [
    ['daemon', daemon],
    ['runtime', runtime],
  ]) {
    const published = git('rev-parse', '--verify', `v${previous.components[component]}^{commit}`);
    for (const path of changesSince(published))
      if (sharedBuild(path) || closure.has(path)) selected.add(component);
  }
}
if (transition && (!selected.has('daemon') || !selected.has('runtime')))
  throw new Error(
    'The first manifest-aware release must publish all components; use --components all',
  );
const plan = validateReleasePlan(
  {
    format: 1,
    version,
    components: Object.fromEntries(
      ['cockpit', 'daemon', 'runtime'].map((name) => [
        name,
        selected.has(name) ? version : previous.components[name],
      ]),
    ),
  },
  version,
);
if (!args.includes('--dry-run'))
  writeFileSync(resolve(root, 'release-manifest.json'), JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify(plan, null, 2));
