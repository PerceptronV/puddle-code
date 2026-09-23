#!/usr/bin/env node
// Release assets and the deployed app always use the same canonical scripts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, override] = process.argv.slice(2);
if (!destination) throw new Error('usage: stage-installers.mjs <directory> [owner/repo]');
const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
const repo = override || pkg.repository.url.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid release repository');
mkdirSync(destination, { recursive: true });
for (const [source, names] of [
  ['install.sh', ['install-daemon.sh', 'install.sh']], // Keep the published daemon URL working.
  ['install-cli.sh', ['install-cli.sh']],
]) {
  const script = readFileSync(join(root, 'scripts', source), 'utf8').replaceAll('@@REPO@@', repo);
  for (const name of names) writeFileSync(join(destination, name), script, { mode: 0o644 });
}
