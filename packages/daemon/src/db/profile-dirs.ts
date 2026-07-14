import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '@puddle/shared';
import type { PuddlePaths } from '../paths.js';

/**
 * Boot-time companion to migration 004: the DB rewrote account config-dir
 * paths from `/profiles/<name>/` to `/profiles/<id>/`; this brings the disk
 * in line by renaming each name-keyed profile directory to its id. Idempotent
 * — a fresh install (or an already-renamed home) matches nothing.
 */
export function reconcileProfileDirs(profiles: Profile[], paths: PuddlePaths): void {
  for (const profile of profiles) {
    const legacy = join(paths.profilesDir, profile.name);
    const target = join(paths.profilesDir, profile.id);
    if (existsSync(legacy) && !existsSync(target)) renameSync(legacy, target);
  }
}
