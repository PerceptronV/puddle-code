#!/usr/bin/env node
import { updateWorkerExecutables } from '@puddle/shared/node/host-control';
import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { hostUpdateOperationSchema } from '@puddle/shared';
import { executeHostUpdate } from './execute.js';
import { readUpdateWorker } from './supervisor.js';

import { executeUpdateRecovery } from '../recovery/worker/execute.js';
import { startUpdateRecoveryWorker } from '../recovery/worker/supervisor.js';
import { runHostInstallationEntry } from '../../host/installation/entry.js';
import { watchUpdateParticipation } from '@puddle/shared/node/host-control';

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
} else if (!(await runHostInstallationEntry(args, fileURLToPath(import.meta.url)))) {
  if (
    (args.length !== 4 &&
      !(
        args.length === 6 &&
        ['--recovery', '--dispatch-recovery', '--participating-recovery'].includes(args[4]!)
      )) ||
    args[0] !== '--home' ||
    args[2] !== '--operation'
  )
    throw new Error(
      'Usage: host-update --home <private-home> --operation <accepted-operation-id> [--recovery <attempt-id> | --dispatch-recovery <revision> | --participating-recovery <revision>]',
    );
  const home = args[1]!;
  // Only trusted host OS/SSH access selects executable paths. Cockpit continuation
  // uses a participating helper; ordinary relay leases cannot reach this entry.
  if (args[4] === '--dispatch-recovery' || args[4] === '--participating-recovery') {
    const participation =
      args[4] === '--participating-recovery' ? watchUpdateParticipation(process.stdin) : null;
    if (participation) process.stdin.resume();
    try {
      const entry = realpathSync(fileURLToPath(import.meta.url));
      const paths = updateWorkerExecutables(home, dirname(dirname(entry)));
      if (paths.entry_path !== entry || paths.node_path !== realpathSync(process.execPath))
        throw new Error('Recovery dispatcher must use its own pinned release');
      const revision = hostUpdateOperationSchema.shape.revision.parse(Number(args[5]));
      const job = await startUpdateRecoveryWorker(
        home,
        { id: args[3]!, revision },
        {
          releasePath: paths.release_path,
          authorised: () => !participation?.signal.aborted,
        },
      );
      console.log(JSON.stringify(job));
    } finally {
      participation?.dispose();
      if (participation) process.stdin.destroy();
    }
  } else {
    const recovery =
      args.length === 6
        ? readUpdateRecoveryAttempts(home, args[3]!).attempts.find(({ job }) => job.id === args[5])
            ?.job
        : undefined;
    if (args.length === 6 && !recovery) throw new Error('Missing accepted recovery dispatch');
    const job = recovery?.service ?? readUpdateWorker(home, args[3]!);
    if (
      realpathSync(process.execPath) !== job.node_path ||
      realpathSync(fileURLToPath(import.meta.url)) !== job.entry_path
    )
      throw new Error('Update worker executable does not match its pinned dispatch');
    // systemd also bounds the service. launchd relies on this worker deadline.
    const deadline = setTimeout(() => process.exit(1), 180_000);
    deadline.unref();
    if (recovery) await executeUpdateRecovery(home, recovery);
    else await executeHostUpdate(home, readUpdateWorker(home, args[3]!));
  }
}
