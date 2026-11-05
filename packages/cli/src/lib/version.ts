import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { releaseRepository as repoSlug } from '@puddle/shared/node/host-control';

// Inlined by esbuild at build time (packages/cli/scripts/build.mjs); dev runs
// (vitest over src) fall back to reading package.json / the environment.
declare const __PUDDLE_CLI_VERSION__: string | undefined;
declare const __PUDDLE_COMPONENT_VERSIONS__: { daemon: string; runtime: string } | undefined;

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
 * The daemon baseline pinned by the release plan; unchanged hosts may skip cockpit tags.
 */
export function pinnedDaemonVersion(): string {
  return pinnedHostVersion('daemon');
}

export function pinnedHostVersion(component: 'daemon' | 'runtime'): string {
  return typeof __PUDDLE_COMPONENT_VERSIONS__ === 'undefined'
    ? cliVersion()
    : __PUDDLE_COMPONENT_VERSIONS__[component];
}
