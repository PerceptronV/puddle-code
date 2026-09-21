import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  atomicPrivateJson,
  digest,
  ipcPath,
  jsonLines,
  listenPrivate,
  privatePath,
  readPrivateJson,
  secret,
} from '@puddle/shared/node';
import { launcherRequestSchema, launcherResponseSchema } from '@puddle/shared';

// Windows named pipes use an additional owner-stored secret, never the registry.
function secretFile(home: string, path: string) {
  return join(home, 'launcher-authority', digest(path) + '.json');
}
export async function startLauncher(home: string, identity: string, invite: () => string) {
  const path = ipcPath(home, `launcher:${identity}`);
  const pipeSecret = process.platform === 'win32' ? secret() : undefined;
  if (pipeSecret) atomicPrivateJson(secretFile(home, path), { secret: pipeSecret });
  const sockets = new Set<Socket>();
  const server = await listenPrivate(path, (socket) => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    let used = false;
    jsonLines(
      socket,
      (value) => {
        const request = launcherRequestSchema.parse(value);
        if (used || (pipeSecret && digest(request.secret ?? '') !== digest(pipeSecret)))
          return socket.destroy();
        used = true;
        socket.end(JSON.stringify({ url: invite() }) + '\n');
      },
      () => socket.destroy(),
    );
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export async function requestInvitation(home: string, path: string): Promise<string> {
  let pipeSecret: string | undefined;
  if (process.platform === 'win32') {
    const stored = readPrivateJson(secretFile(home, path)) as { secret: string };
    pipeSecret = stored.secret;
  } else privatePath(path);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(5000, () => socket.destroy(new Error('Launcher did not answer')));
    jsonLines(
      socket,
      (value) => {
        const message = launcherResponseSchema.parse(value);
        resolve(message.url);
        socket.end();
      },
      () => socket.destroy(new Error('Invalid launcher reply')),
    );
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Launcher closed without an invitation')));
    socket.write(
      JSON.stringify({ t: 'invite', ...(pipeSecret ? { secret: pipeSecret } : {}) }) + '\n',
    );
  });
}
