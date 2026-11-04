import type { Command } from '../args.js';
import { acquireAuthority } from '../../lib/auth/connection-authority.js';
import { inspectHostUpdate } from '../../lib/auth/control-channel.js';
import type { HostUpdateReply } from '@puddle/shared';
import { openHostTransport } from '../../lib/transport/open.js';
import { CliError, type Logger } from '../../lib/types.js';

/** Observe durable state, cancel before dispatch, or explicitly verify completed recovery. */
export async function runUpdates(
  command: Extract<Command, { cmd: 'updates' }>,
  logger: Logger,
): Promise<number> {
  const transport = await openHostTransport(command.host);
  try {
    let authority: Awaited<ReturnType<typeof acquireAuthority>> | undefined;
    let recorded: HostUpdateReply | undefined;
    try {
      authority = await acquireAuthority(transport);
    } catch (error) {
      // Shell-backed inspection can read the ledger, but cannot bypass authority
      // for cancellation, activation or fresh adoption verification.
      if (command.cancel || command.recover) throw error;
      recorded = await inspectHostUpdate(transport, command.operation);
      logger.info('Daemon connection unavailable; showing recorded update state');
    }
    try {
      const generation = authority?.generation;
      let result =
        recorded ?? (await authority!.hostUpdate({ action: 'status', id: command.operation }));
      if (!result.ok)
        throw new CliError('upgrade_failed', `Could not inspect host updates (${result.code})`);
      if (!result.operation) {
        if (command.operation)
          throw new CliError(
            'upgrade_failed',
            `Update ${command.operation} was not found on ${transport.label}`,
          );
        logger.info(`no host update recorded on ${transport.label}`);
        return 0;
      }
      if (command.cancel || command.recover) {
        if (!authority)
          throw new CliError('daemon_unreachable', 'Update actions require live host authority');
        if (!command.operation || command.operation !== result.operation.id)
          throw new CliError('bad_arguments', 'Update actions require the exact update id');
        if (authority.generation !== generation || authority.state !== 'ready')
          throw new CliError(
            'daemon_unreachable',
            'Host connection changed before the update action',
          );
        const reference = { id: result.operation.id, revision: result.operation.revision };
        result = await authority.hostUpdate(
          command.recover
            ? {
                action: 'recover',
                reference,
                strategy: 'verify-completion',
              }
            : {
                action: 'cancel',
                reference,
                reason: 'cancelled',
              },
        );
        if (!result.ok || !result.operation)
          throw new CliError(
            'upgrade_failed',
            command.recover
              ? 'Update completion was not verified; inspect its current state before another recovery action'
              : 'Update was not cancelled; inspect its current state before another action',
          );
      }
      const operation = result.operation;
      logger.info(`host update ${operation.id} on ${transport.label}: ${operation.phase}`);
      for (const target of operation.targets)
        logger.info(`  ${target.component} v${target.version}`);
      if (operation.message) logger.info(operation.message);
      return 0;
    } finally {
      authority?.close();
    }
  } finally {
    transport.dispose();
  }
}
