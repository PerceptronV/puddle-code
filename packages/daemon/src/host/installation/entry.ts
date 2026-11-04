import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectHostRemoval, updateWorkerExecutables } from '@puddle/shared/node/host-control';
import { disposeCompilationCommands, runCompilationCommand } from '../../compilation/process.js';
import { startSelectedDaemon } from '../startup/daemon.js';
import { restoreRemovedHostServices } from '../removal/restoration/execute.js';
import {
  prepareHostRemoval,
  finishHostRemoval,
  inspectHostRemovalResult,
} from '../removal/coordinator.js';
import { hostRemovalFinishSchema } from '@puddle/shared';

/** Commands reachable only through trusted host OS/SSH execution of the selected helper. */
export async function runHostInstallationEntry(args: string[], entry: string): Promise<boolean> {
  if (args[0] !== '--home') return false;
  const action = args[2];
  if (!(
    (args.length === 3 &&
      ['--start-daemon', '--inspect-removal', '--inspect-removal-result'].includes(action!)) ||
    (action === '--prepare-removal' && (args.length === 3 || args.length === 4)) ||
    (action === '--finish-removal' && args.length === 7) ||
    (action === '--restore-services' &&
      (args.length === 4 || (args.length === 5 && args[4] === '--resume')))
  ))
    return false;
  const home = args[1]!;
  let interrupted = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const interrupt = () => {
    interrupted = true;
    disposeCompilationCommands();
  };
  for (const signal of signals) process.on(signal, interrupt);
  try {
    entry = realpathSync(entry);
    const paths = updateWorkerExecutables(home, dirname(dirname(entry)));
    if (
      paths.entry_path !== entry ||
      paths.node_path !== realpathSync(process.execPath) ||
      realpathSync(join(home, 'bin/current')) !== paths.release_path
    )
      throw new Error('Host management must use its own selected release');
    const run: typeof runCompilationCommand = (command) => {
      if (interrupted) throw new Error('Host management was interrupted');
      return runCompilationCommand({ ...command, detached: false });
    };
    if (action === '--inspect-removal') console.log(JSON.stringify(inspectHostRemoval(home)));
    else if (action === '--inspect-removal-result')
      console.log(JSON.stringify(inspectHostRemovalResult(home)));
    else if (action === '--prepare-removal')
      console.log(
        JSON.stringify(
          await prepareHostRemoval(home, paths.release_path, args[3], {
            run,
            authorised: () => !interrupted,
          }),
        ),
      );
    else if (action === '--finish-removal')
      await finishHostRemoval(
        home,
        paths.release_path,
        hostRemovalFinishSchema.parse({
          id: args[3],
          fingerprint: args[4],
          attempt_id: args[5],
          disposition: args[6],
        }),
        { run, authorised: () => !interrupted },
      );
    else if (action === '--restore-services')
      await restoreRemovedHostServices(home, paths.release_path, args[3]!, {
        run,
        authorised: () => !interrupted,
        resume: args[4] === '--resume',
      });
    else await startSelectedDaemon(home, paths.release_path, { run });
    if (interrupted) throw new Error('Host management was interrupted');
  } catch {
    // Saved service configuration may contain secrets; never forward raw diagnostics.
    console.error(
      action === '--start-daemon'
        ? 'The selected daemon could not be started'
        : 'The recorded host removal could not be inspected or restored',
    );
    process.exitCode = 1;
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
  }
  return true;
}
