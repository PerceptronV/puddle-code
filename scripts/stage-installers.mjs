#!/usr/bin/env node
// The public installer installs the CLI; daemon bootstrap stays embedded.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, override] = process.argv.slice(2);
if (!destination) throw new Error('usage: stage-installers.mjs <directory> [owner/repo]');
const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
const repo = override || pkg.repository.url.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid release repository');
mkdirSync(destination, { recursive: true });
// Also remove obsolete public scripts when reusing a staging directory.
for (const name of ['install-cli.sh', 'install-daemon.sh']) {
  rmSync(join(destination, name), { force: true });
}
const script = readFileSync(join(root, 'scripts/install-cli.sh'), 'utf8').replaceAll(
  '@@REPO@@',
  repo,
);
writeFileSync(join(destination, 'install.sh'), script, { mode: 0o644 });
