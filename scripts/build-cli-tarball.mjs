#!/usr/bin/env node
// Package the built cockpit with its own Node; no npm or system Node at runtime.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNodeRuntime } from './lib/node-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
const version = flag('--version') ?? pkg.version;
if (version !== pkg.version) throw new Error('--version must match the built CLI package version');
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`Unsupported CLI platform: ${process.platform}-${process.arch}`);
}
const target = `${process.platform}-${process.arch}`;
const out = resolve(root, flag('--out-dir') ?? 'dist-release');
const name = `puddle-cli-v${version}`;
const stage = join(out, 'stage', name);
const dist = join(root, 'packages/cli/dist');
for (const file of [
  'index.js',
  'host-control.mjs',
  'install.sh',
  'install-cli.sh',
  'public/index.html',
]) {
  if (!existsSync(join(dist, file))) throw new Error(`Missing ${file}; run pnpm build first`);
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, join(stage, 'cli'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(join(stage, 'VERSION'), `${version}\n`);
// Distinguishes an extracted archive from an npm install, even before installation.
writeFileSync(join(stage, 'STANDALONE'), 'puddle-cli\n');
writeFileSync(
  join(stage, 'puddle'),
  '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/cli/index.js" "$@"\n',
);
chmodSync(join(stage, 'puddle'), 0o755);
await stageNodeRuntime(root, stage, target);

// Offline inventory and help never start a daemon. An isolated home and PATH
// prove that the archive needs neither installed npm nor installed Node.
const home = mkdtempSync(join(tmpdir(), 'puddle-cli-smoke-'));
try {
  const env = { HOME: home, PUDDLE_HOME: join(home, '.puddle'), PATH: '/usr/bin:/bin' };
  const output = execFileSync(join(stage, 'puddle'), ['--version'], { env, encoding: 'utf8' });
  if (!output.includes(version)) throw new Error(`CLI version smoke test failed: ${output}`);
  execFileSync(join(stage, 'puddle'), ['--help'], { env, stdio: 'pipe' });
} finally {
  rmSync(home, { recursive: true, force: true });
}
if (!args.includes('--stage-only')) {
  const file = `${name}-${target}.tar.gz`;
  const tarball = join(out, file);
  execFileSync('tar', ['-czf', tarball, '-C', dirname(stage), name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${digest}  ${file}\n`);
  console.log(`CLI archive: ${tarball}`);
}
