import type { Command } from '../args.js';
import { acquireAuthority } from '../../lib/auth/connection-authority.js';
import { openHostTransport } from '../../lib/transport/open.js';
import { CliError, type Logger } from '../../lib/types.js';

/** Observe durable state, cancel before dispatch, or explicitly verify completed recovery. */
export async function runUpdates(
  command: Extract<Command, { cmd: 'updates' }>,
  logger: Logger,
): Promise<number> {
  const transport = await openHostTransport(command.host);
  try {
    const authority = await acquireAuthority(transport);
    try {
      const generation = authority.generation;
      let result = await authority.hostUpdate({ action: 'status', id: command.operation });
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
      authority.close();
    }
  } finally {
    transport.dispose();
  }
}
