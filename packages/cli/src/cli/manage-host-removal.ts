import type { Command } from './args.js';
import { confirm } from './prompt.js';
import { CliError, type Logger } from '../lib/types.js';
import type { Transport } from '../lib/transport/transport.js';
import {
  prepareHostRemoval,
  finishHostRemoval,
  requireHostRemovalSupport,
} from '../lib/installation/host/remove.js';
import { checkFrontend, readFrontendRecord, removeFrontendRecord } from '../lib/registry.js';
import { terminateFrontend } from './detach.js';
import { inspectHostPurge, requireHostPurgeSupport } from '../lib/installation/host/purge.js';
import { purgeRemovedHost } from './manage-host-purge.js';

/** Modern removal keeps the selected helper and every pinned runtime release for recovery. */
export async function removePersistentDaemonCmd(
  cmd: Extract<Command, { cmd: 'remove' }>,
  transport: Transport,
  logger: Logger,
): Promise<number> {
  await requireHostRemovalSupport(transport);
  if (cmd.purge) {
    await requireHostPurgeSupport(transport);
    if (cmd.yes && !cmd.stopRuntimes)
      throw new CliError(
        'bad_arguments',
        'Purge requires separate runtime stop consent',
        'Pass --stop-runtimes as well as --purge, or remove without purging to retain the runtimes and data.',
      );
    const purge = await inspectHostPurge(transport);
    if (purge) return purgeRemovedHost(cmd, transport, logger, purge.id);
  }
  logger.warn(
    'Removing the daemon interrupts its daemon-owned terminals, notebook kernels, compilation tasks and programmes, and disables remote access.',
  );
  logger.info(
    'Independent agent, terminal and huddle runtimes keep running unless you explicitly choose to stop them. Retaining a huddle does not stop its triggers or scripts; terminal counts do not include that work.',
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
      'Also stop these runtimes, including agent/shell jobs and huddle triggers/scripts? Choosing no retains them for reinstallation.',
    );
  if (cmd.purge && !stop)
    stop = await confirm('Stop all runtime work as a separate prerequisite for purging data?');
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
  const frontend = readFrontendRecord(target);
  if (frontend) {
    if ((await checkFrontend(frontend)) === 'dead') removeFrontendRecord(target);
    else await terminateFrontend(frontend);
  }
  if (cmd.purge && stop) {
    logger.info(
      `puddled removed from ${transport.label}; runtimes stopped. Data purge is pending.`,
    );
    return purgeRemovedHost(cmd, transport, logger, review.id);
  }
  logger.info(
    `puddled removed from ${transport.label}; runtimes ${stop ? 'stopped' : 'retained'}. Data and pinned releases kept — use \`puddle install daemon${cmd.host ? ` ${cmd.host}` : ''}\` to restore the service.`,
  );
  if (cmd.purge)
    logger.info('Purge declined because runtime stop consent was not given; data retained.');
  return 0;
}
