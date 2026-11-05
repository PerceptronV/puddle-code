import {
  PROTOCOL_VERSION,
  hostMaintenanceCommandSchema,
  hostMaintenanceReplySchema,
  presentHostUpdate,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
  type HostUpdateCommand,
  type HostUpdateReply,
  type HostUpdateTargets,
  type HostStageReceipt,
} from '@puddle/shared';
import { prepareHostUpdateOperation } from '@puddle/shared/node/host-control';

/** Same coordinator and exact approvals as local cockpits, with host-owned preparation and public results. */
export class RemoteHostUpdates {
  constructor(
    private readonly deps: {
      version: string;
      execute(command: HostUpdateCommand, authorised: () => boolean): Promise<HostUpdateReply>;
      stage(
        repository: string,
        target: HostUpdateTargets[number],
        authorised: () => boolean,
      ): Promise<HostStageReceipt>;
    },
  ) {}

  async execute(
    input: HostMaintenanceCommand,
    authorised: () => boolean,
  ): Promise<HostMaintenanceReply> {
    const command = hostMaintenanceCommandSchema.parse(input);
    const requireAuthority = () => {
      if (!authorised()) throw new Error('Host maintenance authority expired');
    };
    const execute = async (request: HostUpdateCommand) => {
      requireAuthority();
      const result = await this.deps.execute(request, authorised);
      requireAuthority();
      return result;
    };
    requireAuthority();
    if (command.action === 'status') {
      const reply = await execute({
        action: 'status',
        ...(command.id ? { id: command.id } : {}),
        include_catalogue: true,
        ...(command.include_component_releases ? { include_component_releases: true } : {}),
        include_recovery: true,
      });
      return hostMaintenanceReplySchema.parse({
        kind: 'status',
        status: {
          availability: 'ready',
          observation: 'live',
          daemon_version: this.deps.version,
          capabilities: {
            interruption_approval: true,
            verify_completion: true,
            continue_recovery: true,
            offline_continuation: false,
          },
          result: presentHostUpdate(reply, { redactMessage: true }),
          ...(reply.ok && reply.catalogue
            ? {
                catalogue: {
                  ...reply.catalogue,
                  releases: { ...reply.catalogue.releases, repository: null },
                },
              }
            : {}),
        },
      });
    }
    let reply: HostUpdateReply;
    if (command.action === 'prepare') {
      const status = await execute({ action: 'status', include_catalogue: true });
      const repository = status.ok ? status.catalogue?.releases.repository : null;
      if (!repository) throw new Error('No host release source is configured');
      const operation = await prepareHostUpdateOperation(command.targets, {
        authorised,
        execute,
        stage: (target) => this.deps.stage(repository, target, authorised),
      });
      reply = { ok: true, operation };
    } else {
      const request: HostUpdateCommand =
        command.action === 'cancel'
          ? { ...command, reason: 'cancelled' }
          : command.action === 'inspect' || command.action === 'apply'
            ? { ...command, cockpit: PROTOCOL_VERSION }
            : command;
      reply = await execute(request);
    }
    requireAuthority();
    return { kind: 'result', result: presentHostUpdate(reply, { redactMessage: true }) };
  }
}
