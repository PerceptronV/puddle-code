import type { Command } from './args.js';
import { confirm } from './prompt.js';
import { CliError, type Logger } from '../lib/types.js';
import type { Transport } from '../lib/transport/transport.js';
import {
  prepareHostRemoval,
  finishHostRemoval,
  requireHostRemovalSupport,
} from '../lib/installation/host/remove.js';
import { checkCockpit, readCockpitRecord, removeCockpitRecord } from '../lib/registry.js';
import { terminateCockpit } from './detach.js';

/** Modern removal keeps the selected helper and every pinned runtime release for recovery. */
export async function removePersistentDaemonCmd(
  cmd: Extract<Command, { cmd: 'remove' }>,
  transport: Transport,
  logger: Logger,
): Promise<number> {
  await requireHostRemovalSupport(transport);
  if (cmd.purge)
    throw new CliError(
      'bad_arguments',
      'Coordinated purge of persistent runtime installations is not implemented yet',
      'Remove without --purge to retain runtime binaries, worktrees and data',
    );
  logger.warn(
    'Removing the daemon interrupts its daemon-owned terminals, notebook kernels, compilation tasks and programmes, and disables remote access.',
  );
  logger.info(
    'Independent agent and terminal runtimes keep running unless you explicitly choose to stop them.',
  );
  if (!(await confirm(`Stop and unregister puddled on ${transport.label}?`, { skip: cmd.yes }))) {
    logger.info('nothing removed');
    return 0;
  }
  const review = await prepareHostRemoval(transport);
  logger.info(`${review.owners.length} independent runtime(s) on ${transport.label}:`);
  for (const owner of review.owners)
    logger.info(
      `  ${owner.session.slice(0, 8)}  runtime ${owner.id.slice(0, 8)}  v${owner.version}  ${owner.terminals ?? 'unknown'} live terminal(s)${owner.stop_blocker ? ` — ${owner.stop_blocker}` : ''}`,
    );
  let stop = cmd.stopRuntimes === true;
  if (review.owners.length && !stop && !cmd.yes)
    stop = await confirm(
      'Also stop these runtimes and their shell jobs? Choosing no retains them for reinstallation.',
    );
  if (stop && review.owners.some(({ stop_blocker }) => stop_blocker !== null))
    throw new CliError(
      'upgrade_failed',
      'Some runtimes cannot be safely stopped from this review',
      'Resolve their pending stop or persistence state, or rerun removal and retain the runtimes',
    );
  await finishHostRemoval(transport, {
    id: review.id,
    fingerprint: review.fingerprint,
    disposition: stop ? 'stop' : 'retain',
  });
  const target = cmd.host ?? 'local';
  const cockpit = readCockpitRecord(target);
  if (cockpit) {
    if ((await checkCockpit(cockpit)) === 'dead') removeCockpitRecord(target);
    else await terminateCockpit(cockpit);
  }
  logger.info(
    `puddled removed from ${transport.label}; runtimes ${stop ? 'stopped' : 'retained'}. Data and pinned releases kept — use \`puddle install daemon${cmd.host ? ` ${cmd.host}` : ''}\` to restore the service.`,
  );
  return 0;
}
