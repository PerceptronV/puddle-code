#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeHostUpdate } from './execute.js';
import { readUpdateWorker } from './supervisor.js';
import { verifyUpdateWorkerIsolation } from './isolation.js';

declare const __PUDDLED_VERSION__: string | undefined;
const version =
  typeof __PUDDLED_VERSION__ !== 'undefined'
    ? __PUDDLED_VERSION__
    : (
        JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log(`puddle host updater ${version}`);
} else {
  if (args.length !== 4 || args[0] !== '--home' || args[2] !== '--operation')
    throw new Error('Usage: host-update --home <private-home> --operation <accepted-operation-id>');
  const home = args[1]!;
  const job = readUpdateWorker(home, args[3]!);
  if (
    realpathSync(process.execPath) !== job.node_path ||
    realpathSync(fileURLToPath(import.meta.url)) !== job.entry_path
  )
    throw new Error('Update worker executable does not match its pinned dispatch');
  // systemd also bounds the service. launchd relies on this worker deadline.
  const deadline = setTimeout(() => process.exit(1), 180_000);
  deadline.unref();
  await verifyUpdateWorkerIsolation(home, job);
  await executeHostUpdate(home, job);
}
