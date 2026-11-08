import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalHuddleJson,
  runtimeReleaseCapabilitiesSchema,
  supportsHuddleRuntime,
} from '@puddle/shared';
import { readReleaseText } from '../../../host/releases/files.js';
import { resolveInstalledRuntimeRelease } from '../../lifecycle/release.js';

/** A missing role file never changes admission for ordinary agent/terminal runtimes. */
export function resolveHuddleRuntimeRelease(home: string) {
  const selected = resolveInstalledRuntimeRelease(home);
  let raw: unknown;
  try {
    raw = JSON.parse(
      readReleaseText(join(selected.releasePath, 'RUNTIME_CAPABILITIES.json'), 32 * 1024),
    );
  } catch {
    throw new Error('Selected runtime has no readable huddle capability metadata');
  }
  const capabilities = runtimeReleaseCapabilitiesSchema.parse(raw);
  if (
    capabilities.version !== selected.build ||
    capabilities.protocol.major !== selected.protocol.major ||
    capabilities.protocol.minor !== selected.protocol.minor
  )
    throw new Error('Huddle capability metadata does not match the selected runtime');
  if (!supportsHuddleRuntime(capabilities.roles.huddle))
    throw new Error('Selected runtime does not support these huddle contracts');
  const workerEntry = pinnedHelper(selected.releasePath, 'runner.js');
  const sdkEntry = pinnedHelper(selected.releasePath, 'sdk.js');
  return { ...selected, huddle: capabilities.roles.huddle, workerEntry, sdkEntry };
}
export type HuddleRuntimeRelease = ReturnType<typeof resolveHuddleRuntimeRelease>;

/** Recheck immediately before recording intent after asynchronous worktree/account resolution. */
export function requireHuddleRuntimeSelection(home: string, expected: HuddleRuntimeRelease): void {
  const current = resolveHuddleRuntimeRelease(home);
  if (canonicalHuddleJson(current) !== canonicalHuddleJson(expected))
    throw new Error('Selected huddle runtime changed before launch admission');
}

function pinnedHelper(release: string, name: string) {
  const path = realpathSync(join(release, 'daemon', 'huddle', name));
  if (dirname(path) !== join(release, 'daemon', 'huddle') || !statSync(path).isFile())
    throw new Error('Huddle helper is outside its pinned runtime release');
  accessSync(path, constants.R_OK);
  return path;
}
