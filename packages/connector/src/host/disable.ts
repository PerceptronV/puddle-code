import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { connectorConfigSchema } from '@puddle/shared';
import {
  atomicPrivateJson,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { registeredProfiles, profileDirectory } from '../profile-state.js';
import { administrativeRequest } from '../admin.js';

function config(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return connectorConfigSchema.parse(readPrivateJson(path, 64 * 1024));
}

function profiles(home: string): string[] {
  for (const path of [join(home, 'remote'), join(home, 'remote/profiles')]) {
    try {
      privatePath(path, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  const result = registeredProfiles(home);
  if (result.length > 1024) throw new Error('Remote profile inventory exceeds its limit');
  for (const profile of result) privatePath(profileDirectory(home, profile), true);
  return result;
}

/** Host removal reuses ordinary per-profile disable; never deletes registrations or grants. */
export async function disableAllProfiles(home: string): Promise<void> {
  const registered = profiles(home);
  const legacy = join(home, 'remote/config.json');
  const previous = config(legacy);
  if (previous) atomicPrivateJson(legacy, { ...previous, enabled: false }, { syncDirectory: true });
  for (const profile of registered) {
    if (!config(join(profileDirectory(home, profile), 'config.json'))) continue;
    const result = await administrativeRequest(home, { t: 'disable' }, profile);
    if (result.error) throw new Error('Could not disable remote access');
  }
  requireAllProfilesDisabled(home);
}

/** Observation after a lost reply; validates private configuration without exposing its contents. */
export function requireAllProfilesDisabled(home: string): void {
  const remote = join(home, 'remote');
  try {
    privatePath(remote, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const directory of [remote, ...profiles(home).map((id) => profileDirectory(home, id))]) {
    const value = config(join(directory, 'config.json'));
    if (value?.enabled) throw new Error('Remote access remains enabled');
    // A returned write without its parent-directory sync is not durable disablement.
    if (value) syncPrivateDirectory(directory);
  }
}
