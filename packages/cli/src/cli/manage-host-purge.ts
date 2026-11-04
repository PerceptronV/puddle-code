import type { Command } from './args.js';
import { confirm } from './prompt.js';
import type { Logger } from '../lib/types.js';
import type { Transport } from '../lib/transport/transport.js';
import { prepareHostPurge, applyHostPurge } from '../lib/installation/host/purge.js';

/** Purge consent is distinct from runtime stop consent and ordinary daemon removal. */
export async function purgeRemovedHost(
  cmd: Extract<Command, { cmd: 'remove' }>,
  transport: Transport,
  logger: Logger,
  id: string,
): Promise<number> {
  const review = await prepareHostPurge(transport, id);
  if (review.phase === 'reboot_required') {
    logger.warn(
      'The daemon and runtimes are removed, but their descendants may still be running. Data has been retained.',
    );
    logger.info(
      'Reboot the target machine, then rerun this explicit purge command. A changed kernel boot identity is required before deleting data.',
    );
    return 0;
  }
  if (review.phase === 'complete') {
    logger.info(
      'The recorded data purge is complete. Installation locks, private recovery records and retained releases remain.',
    );
    return 0;
  }
  for (const worktree of review.worktrees.filter((entry) => entry.dirty || entry.local_only))
    logger.warn(
      `  ${worktree.path} — ${[worktree.dirty ? 'uncommitted work' : '', worktree.local_only ? 'unpushed commits' : ''].filter(Boolean).join(', ')}`,
    );
  logger.warn(
    'Purge deletes managed worktrees, profiles, agent configuration and session history. Installation locks, private recovery records (including saved service definitions) and retained releases remain.',
  );
  if (
    !(await confirm(
      review.phase === 'deleting'
        ? 'Continue this partially completed data purge?'
        : 'Delete this reviewed data, including any uncommitted or unpushed work?',
      { skip: cmd.yes },
    ))
  ) {
    logger.info('Data retained; no further purge deletion was dispatched.');
    return 0;
  }
  let result = review;
  const deadline = Date.now() + 60_000;
  for (let pass = 0; pass < 64 && Date.now() < deadline; pass++) {
    const applied = await applyHostPurge(
      transport,
      result,
      Math.max(1, Math.min(30_000, deadline - Date.now())),
    );
    result = applied.review;
    if (result.phase === 'complete' || !applied.dispatchAcknowledged) break;
  }
  logger.info(
    result.phase === 'complete'
      ? 'Managed user data purged. Installation locks, private recovery records and retained releases remain; an explicit install starts a fresh host.'
      : 'Purge remains incomplete; data may be partially deleted. Rerun this explicit command to continue before reinstalling. No uncertain deletion was automatically retried.',
  );
  return 0;
}
