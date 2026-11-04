import type { Command } from '../args.js';
import { acquireAuthority } from '../../lib/auth/connection-authority.js';
import { continueHostUpdate, inspectHostUpdate } from '../../lib/auth/control-channel.js';
import type { HostUpdateReply } from '@puddle/shared';
import { openHostTransport } from '../../lib/transport/open.js';
import { CliError, type Logger } from '../../lib/types.js';

/** Observe durable state, cancel preparation, verify completion or explicitly continue once. */
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
      // Only explicit continuation uses OS/SSH authority while disconnected.
      // Never turn a failed live mutation into another dispatch through this path.
      if (command.cancel || command.recover) throw error;
      recorded = await inspectHostUpdate(transport, command.operation, true);
      logger.info('Daemon connection unavailable; showing recorded update state');
    }
    try {
      const generation = authority?.generation;
      const protocol = authority?.version?.protocol;
      const recoverySupported =
        protocol && (protocol.major > 25 || (protocol.major === 25 && protocol.minor >= 12));
      let result =
        recorded ??
        (await authority!.hostUpdate({
          action: 'status',
          id: command.operation,
          ...(recoverySupported ? { include_recovery: true } : {}),
        }));
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
      if (command.cancel || command.recover || command.continue) {
        if (!authority && !command.continue)
          throw new CliError('daemon_unreachable', 'Update actions require live host authority');
        if (!command.operation || command.operation !== result.operation.id)
          throw new CliError('bad_arguments', 'Update actions require the exact update id');
        if (authority && (authority.generation !== generation || authority.state !== 'ready'))
          throw new CliError(
            'daemon_unreachable',
            'Host connection changed before the update action',
          );
        const reference = { id: result.operation.id, revision: result.operation.revision };
        if (command.continue && authority && !recoverySupported)
          throw new CliError(
            'protocol_mismatch',
            'Host update continuation requires application protocol 25.12 or newer',
          );
        result = !authority
          ? await continueHostUpdate(transport, reference)
          : await authority.hostUpdate(
              command.recover || command.continue
                ? {
                    action: 'recover',
                    reference,
                    strategy: command.continue ? 'continue' : 'verify-completion',
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
            command.continue
              ? 'Update continuation was not confirmed; inspect its recorded state before another action'
              : command.recover
                ? 'Update completion was not verified; inspect its current state before another recovery action'
                : 'Update was not cancelled; inspect its current state before another action',
          );
      }
      const operation = result.operation;
      logger.info(`host update ${operation.id} on ${transport.label}: ${operation.phase}`);
      for (const target of operation.targets)
        logger.info(`  ${target.component} v${target.version}`);
      if (operation.message) logger.info(operation.message);
      if (result.recovery) {
        logger.info(
          `recorded recovery ${result.recovery.id}: ${result.recovery.consumed ? 'worker consumed the attempt' : 'accepted for dispatch'}`,
        );
        if (operation.phase !== 'complete')
          logger.info(
            `Recovery is not yet verified complete; inspect with puddle updates${command.host ? ` ${command.host}` : ''} --operation ${operation.id}`,
          );
      }
      return 0;
    } finally {
      authority?.close();
    }
  } finally {
    transport.dispose();
  }
}
