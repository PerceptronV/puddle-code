import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Socket } from 'node:net';
import {
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  connectorInspectionRequestSchema,
  connectorInspectionResponseSchema,
} from '@puddle/shared';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';

/** Reuse the manager's exclusive private socket, without exposing profile or registration data. */
export async function startConnectorInspection(
  home: string,
  executable: { version: string; entryPath: string },
  ready: () => boolean,
) {
  const entry = realpathSync(executable.entryPath);
  const identity = {
    instance: randomUUID(),
    pid: process.pid,
    version: executable.version,
    application: PROTOCOL_VERSION,
    remote: REMOTE_PROTOCOL_VERSION,
    node_path: realpathSync(process.execPath),
    entry_path: entry,
    release_path: dirname(dirname(entry)),
  };
  const sockets = new Set<Socket>();
  const server = await listenPrivate(ipcPath(home, 'remote'), (socket) => {
    if (sockets.size >= 8) return socket.destroy();
    sockets.add(socket);
    let used = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    timer.unref();
    const stop = jsonLines(
      socket,
      (value) => {
        if (used) return socket.destroy();
        used = true;
        const request = connectorInspectionRequestSchema.parse(value);
        const response = connectorInspectionResponseSchema.parse({
          ...identity,
          t: 'inspection',
          nonce: request.nonce,
          ready: ready(),
        });
        const encoded = JSON.stringify(response) + '\n';
        if (Buffer.byteLength(encoded) > 16 * 1024) return socket.destroy();
        socket.end(encoded);
      },
      () => socket.destroy(),
      1024,
    );
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer);
      stop();
      sockets.delete(socket);
    });
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
