import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Removes a directory only if it sits inside the given root — a guard so a
 * corrupted config_dir row can never aim rm -rf outside ~/.puddle/profiles.
 */
export function removeDirWithin(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    console.warn(`refusing to remove ${resolvedTarget}: outside ${resolvedRoot}`);
    return;
  }
  rmSync(resolvedTarget, { recursive: true, force: true });
}
