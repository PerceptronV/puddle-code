import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inlined by esbuild at build time (packages/cli/scripts/build.mjs); dev runs
// (vitest over src) fall back to reading package.json / the environment.
declare const __PUDDLE_CLI_VERSION__: string | undefined;
declare const __PUDDLE_REPO_SLUG__: string | undefined;

export function cliVersion(): string {
  if (typeof __PUDDLE_CLI_VERSION__ !== 'undefined') return __PUDDLE_CLI_VERSION__;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version !== undefined) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return '0.0.0';
}

/**
 * The daemon release the CLI installs and upgrades to — the same version
 * train as the CLI itself (one tag releases both).
 */
export function pinnedDaemonVersion(): string {
  return cliVersion();
}

/**
 * GitHub `owner/repo` to fetch daemon tarballs from. Baked in by the release
 * build (from the publishing repository); development overrides with
 * PUDDLE_REPO. Undefined means releases are unreachable — bootstrap then
 * requires --tarball.
 */
export function repoSlug(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.PUDDLE_REPO !== undefined && env.PUDDLE_REPO !== '') return env.PUDDLE_REPO;
  if (typeof __PUDDLE_REPO_SLUG__ !== 'undefined') return __PUDDLE_REPO_SLUG__;
  return undefined;
}
