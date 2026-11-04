import {
  CONNECTION_POLICY,
  CONTROL_MAX_BYTES,
  controlRequestSchema,
  hostUpdateReplySchema,
  type HostUpdateCommand,
  type HostUpdateReply,
  type ControlResponse,
  type VersionResponse,
} from '@puddle/shared';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';
import type { Socket } from 'node:net';
import type { LeaseRegistry } from './leases.js';

/** Socket directory ownership is the bootstrap authority; HTTP tokens cannot enter here. */
export async function startHostControl(
  home: string,
  registry: LeaseRegistry,
  info: () => { port: number; version: VersionResponse } | null,
  update?: (command: HostUpdateCommand, authorised: () => boolean) => Promise<HostUpdateReply>,
) {
  const sockets = new Set<Socket>();
  const server = await listenPrivate(ipcPath(home, 'host'), (socket) => {
    sockets.add(socket);
    let generation: string | undefined;
    const updateRequests = new Set<string>();
    let pendingUpdates = 0;
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
        if (message.t === 'host-update') {
          if (updateRequests.has(message.request_id) || updateRequests.size >= 1024) return fail();
          updateRequests.add(message.request_id);
          const authority = generation ? registry.controlAuthority(generation) : null;
          const authorised = () =>
            !socket.destroyed &&
            !!authority &&
            authority.profile === undefined &&
            authority.valid();
          const reply = (result: HostUpdateReply) => {
            if (socket.destroyed) return;
            const response: ControlResponse = {
              t: 'host-update-result',
              request_id: message.request_id,
              result,
            };
            if (Buffer.byteLength(JSON.stringify(response)) > CONTROL_MAX_BYTES) {
              send({
                t: 'host-update-result',
                request_id: message.request_id,
                result: { ok: false, code: 'failed', operation: null },
              });
            } else send(response);
          };
          if (!authorised()) {
            reply({ ok: false, code: 'rejected', operation: null });
            return;
          }
          if (!update || pendingUpdates >= 4) {
            reply({ ok: false, code: 'unavailable', operation: null });
            return;
          }
          pendingUpdates++;
          void Promise.resolve()
            .then(() =>
              authorised()
                ? update(message.command, authorised)
                : { ok: false as const, code: 'rejected' as const, operation: null },
            )
            .then((result) =>
              reply(
                authorised()
                  ? hostUpdateReplySchema.parse(result)
                  : { ok: false, code: 'rejected', operation: null },
              ),
            )
            .catch(() =>
              reply({ ok: false, code: authorised() ? 'failed' : 'rejected', operation: null }),
            )
            .finally(() => pendingUpdates--);
          return;
        }
        if (message.t === 'close') {
          socket.end();
          if (generation) registry.revoke(generation);
          return;
        }
        if (message.t === 'open') {
          if (generation) return fail();
          const issued = registry.create(message.profile);
          generation = issued.generation;
          send({ t: 'authority', ...issued, ...ready, validForMs: CONNECTION_POLICY.leaseMs });
        } else {
          const renewed = generation && registry.renew(generation, message.resources);
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
