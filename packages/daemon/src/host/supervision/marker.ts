import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export class SupervisorMarkerPermissionsError extends Error {
  constructor() {
    super('Supervisor marker is writable by another user or group');
    this.name = 'SupervisorMarkerPermissionsError';
  }
}

export async function readSupervisorMarker(home: string, uid: number): Promise<string> {
  const file = await open(
    join(home, 'supervisor'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    // Legacy installers made this public-readable, but never trust a shared writer.
    if (!stat.isFile() || stat.size > 32 || stat.uid !== uid)
      throw new Error('Invalid supervisor marker');
    if ((stat.mode & 0o022) !== 0) throw new SupervisorMarkerPermissionsError();
    const bytes = Buffer.alloc(33);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size || bytesRead > 32) throw new Error('Invalid supervisor marker');
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
}
