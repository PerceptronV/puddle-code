import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { atomicPrivateJson, privatePath, readPrivateJson } from '@puddle/shared/node';

export type CliVersion = readonly [number, number, number];
export const VERSION_CACHE_MS = 30_000;

/** Observe the executable anew, including symlink replacement and in-place installs. */
export function versionExecutableIdentity(binary: string, env: NodeJS.ProcessEnv): string | null {
  const candidates =
    binary.includes('/') || binary.includes('\\')
      ? [resolve(binary)]
      : (env.PATH ?? '').split(delimiter).map((dir) => resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      const stat = statSync(path, { bigint: true });
      if (stat.isFile())
        return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0');
    } catch {
      /* Missing or inaccessible candidates cannot justify a cache hit. */
    }
  }
  return null;
}

/** One bounded optional observation per managed account, shared by successive owners. */
export function readVersionObservation(
  directory: string,
  key: string,
): { at: number; version: CliVersion } | null {
  try {
    privatePath(directory, true);
    const value = readPrivateJson(join(directory, '.puddle-cli-version.json'), 4096) as {
      format?: unknown;
      key?: unknown;
      at?: unknown;
      version?: unknown;
    };
    if (
      value?.format !== 1 ||
      value.key !== key ||
      typeof value.at !== 'number' ||
      !Number.isFinite(value.at) ||
      value.at > Date.now() ||
      Date.now() - value.at >= VERSION_CACHE_MS ||
      !Array.isArray(value.version) ||
      value.version.length !== 3 ||
      !value.version.every((part) => Number.isSafeInteger(part) && part >= 0)
    )
      return null;
    return { at: value.at, version: value.version as unknown as CliVersion };
  } catch {
    return null;
  }
}

export function writeVersionObservation(directory: string, key: string, version: CliVersion): void {
  try {
    privatePath(directory, true);
    atomicPrivateJson(join(directory, '.puddle-cli-version.json'), {
      format: 1,
      key,
      at: Date.now(),
      version,
    });
  } catch {
    /* A cache failure must not reject an otherwise verified launch. */
  }
}
