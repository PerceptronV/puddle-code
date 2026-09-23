import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { profileId } from '@puddle/shared';
import { privateDirectory } from '@puddle/shared/node';

export function profileDirectory(home: string, profile: string): string {
  profileId.parse(profile);
  for (const directory of [join(home, 'remote'), join(home, 'remote', 'profiles')])
    if (existsSync(directory)) privateDirectory(directory);
  return join(home, 'remote', 'profiles', profile);
}
export function registeredProfiles(home: string): string[] {
  const remote = join(home, 'remote');
  if (existsSync(remote)) privateDirectory(remote);
  const directory = join(remote, 'profiles');
  if (!existsSync(directory)) return [];
  privateDirectory(directory);
  return readdirSync(directory).filter((id) => profileId.safeParse(id).success);
}
