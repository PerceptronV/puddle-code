import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { profileId } from '@puddle/shared';

/** Serialise local/SSH writers across cockpit windows and CLI processes. */
export async function profileMutation<T>(
  home: string,
  profile: string,
  action: () => Promise<T>,
): Promise<T> {
  profileId.parse(profile);
  const lock = await listenPrivate(ipcPath(home, `remote-write-${profile}`), (socket) =>
    socket.destroy(),
  );
  try {
    return await action();
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
}
