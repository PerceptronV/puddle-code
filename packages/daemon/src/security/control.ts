import {
  CONNECTION_POLICY,
  CONTROL_MAX_BYTES,
  controlRequestSchema,
  hostUpdateReplySchema,
  hostMaintenanceReplySchema,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
  type RemoteMaintenanceClaim,
  type HostUpdateCommand,
  type HostUpdateReply,
  type ControlResponse,
  type VersionResponse,
} from '@puddle/shared';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';
import type { Socket } from 'node:net';
import type { LeaseRegistry } from './leases.js';

export interface HostMaintenanceControl {
  check(profile: string, claim: RemoteMaintenanceClaim): boolean;
  execute(
    command: HostMaintenanceCommand,
    authorised: () => boolean,
  ): Promise<HostMaintenanceReply>;
}

/** Socket directory ownership is the bootstrap authority; HTTP tokens cannot enter here. */
export async function startHostControl(
  home: string,
  registry: LeaseRegistry,
  info: () => { port: number; version: VersionResponse } | null,
  update?: (command: HostUpdateCommand, authorised: () => boolean) => Promise<HostUpdateReply>,
  maintenance?: HostMaintenanceControl,
) {
  const sockets = new Set<Socket>();
  const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
    sockets.add(socket);
    let generation: string | undefined;
    const updateRequests = new Set<string>();
    let pendingUpdates = 0;
    let maintenanceClaim: RemoteMaintenanceClaim | undefined;
    let maintenanceProfile: string | undefined;
    let maintenanceRevoked = false;
    const maintenanceValid = () => {
      if (maintenanceRevoked || !maintenanceClaim || !maintenanceProfile || !maintenance)
        return false;
      try {
        if (maintenance.check(maintenanceProfile, maintenanceClaim)) return true;
      } catch {
        /* Missing or unreadable private authority fails closed. */
      }
      maintenanceRevoked = true;
      return false;
    };
    const send = (message: ControlResponse) => socket.write(JSON.stringify(message) + '\n');
    const fail = () => {
      send({ t: 'error', code: 'invalid_control' });
      socket.destroy();
    };
    const stop = jsonLines(
      socket,
      (value) => {
        const parsed = controlRequestSchema.safeParse(value);
        if (!parsed.success) return fail();
        const message = parsed.data;
        const ready = info();
        if (!ready) {
          send({ t: 'error', code: 'unavailable' });
          socket.end();
          return;
        }
        if (message.t === 'host-update' || message.t === 'host-maintenance') {
          // Both bounded RPCs share one channel budget; maintenance never renews it.
          if (updateRequests.has(message.request_id) || updateRequests.size >= 1024) return fail();
          updateRequests.add(message.request_id);
          const authority = generation ? registry.controlAuthority(generation) : null;
          const participating = () => !socket.destroyed && !!authority && authority.valid();
          const run = <Reply>(options: {
            authorised(): boolean;
            execute?: () => Promise<Reply>;
            parse(value: unknown): Reply;
            failure(code: 'rejected' | 'unavailable' | 'failed'): Reply;
            response(result: Reply): ControlResponse;
          }) => {
            const reply = (result: Reply) => {
              if (socket.destroyed) return;
              const response = options.response(result);
              send(
                Buffer.byteLength(JSON.stringify(response)) > CONTROL_MAX_BYTES
                  ? options.response(options.failure('failed'))
                  : response,
              );
            };
            if (!options.authorised()) return reply(options.failure('rejected'));
            if (!options.execute || pendingUpdates >= 4)
              return reply(options.failure('unavailable'));
            pendingUpdates++;
            void Promise.resolve()
              .then(() => (options.authorised() ? options.execute!() : options.failure('rejected')))
              .then((result) =>
                reply(options.authorised() ? options.parse(result) : options.failure('rejected')),
              )
              .catch(() => reply(options.failure(options.authorised() ? 'failed' : 'rejected')))
              .finally(() => pendingUpdates--);
          };
          if (message.t === 'host-update') {
            const authorised = () => participating() && authority?.profile === undefined;
            run<HostUpdateReply>({
              authorised,
              execute: update ? () => update(message.command, authorised) : undefined,
              parse: hostUpdateReplySchema.parse,
              failure: (code) => ({ ok: false, code, operation: null }),
              response: (result) => ({
                t: 'host-update-result',
                request_id: message.request_id,
                result,
              }),
            });
          } else {
            const authorised = () =>
              participating() && authority?.profile === maintenanceProfile && maintenanceValid();
            run<HostMaintenanceReply>({
              authorised,
              execute: maintenance
                ? () => maintenance.execute(message.command, authorised)
                : undefined,
              parse: hostMaintenanceReplySchema.parse,
              failure: (code) =>
                message.command.action === 'status'
                  ? {
                      kind: 'status',
                      status: {
                        availability: 'unavailable',
                        daemon_version: null,
                        capabilities: {
                          interruption_approval: false,
                          verify_completion: false,
                          continue_recovery: false,
                        },
                        result: null,
                      },
                    }
                  : { kind: 'result', result: { ok: false, code, operation: null } },
              response: (result) => ({
                t: 'host-maintenance-result',
                request_id: message.request_id,
                result,
              }),
            });
          }
          return;
        }
        if (message.t === 'close') {
          socket.end();
          if (generation) registry.revoke(generation);
          return;
        }
        if (message.t === 'open') {
          if (generation) return fail();
          if (message.maintenance) {
            maintenanceClaim = message.maintenance;
            maintenanceProfile = message.profile;
            if (!maintenanceValid()) {
              send({ t: 'error', code: 'rejected' });
              socket.end();
              return;
            }
          }
          const issued = registry.create(message.profile);
          generation = issued.generation;
          send({ t: 'authority', ...issued, ...ready, validForMs: CONNECTION_POLICY.leaseMs });
        } else {
          const renewed =
            generation &&
            (!maintenanceClaim || maintenanceValid()) &&
            registry.renew(generation, message.resources);
          if (!renewed) {
            send({ t: 'error', code: 'rejected' });
            socket.end();
            return;
          }
          send({ t: 'authority', ...renewed, ...ready, validForMs: CONNECTION_POLICY.leaseMs });
        }
      },
      fail,
    );
    socket.setTimeout(CONNECTION_POLICY.leaseMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (generation) registry.revoke(generation);
    });
    socket.on('close', () => {
      stop();
      sockets.delete(socket);
      if (generation) registry.revoke(generation);
    });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
