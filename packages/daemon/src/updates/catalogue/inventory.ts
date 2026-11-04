import { hostUpdateCatalogueSchema, type HostUpdateCatalogue } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../runtime/transport/connections.js';
import { resolveInstalledRuntimeRelease } from '../../runtime/lifecycle/release.js';
import type { HostReleaseChecks } from './releases.js';

/** Reuse committed bindings and existing connections; no owner RPCs or native-store scans. */
export function hostUpdateCatalogue(deps: {
  home: string;
  version: string;
  runtimes: Pick<RuntimeStore, 'live'>;
  connections: Pick<RuntimeConnections, 'get'>;
  releases: Pick<HostReleaseChecks, 'read'>;
  installed?: typeof resolveInstalledRuntimeRelease;
}): HostUpdateCatalogue {
  let runtime_default: HostUpdateCatalogue['runtime_default'] = null;
  try {
    const installed = (deps.installed ?? resolveInstalledRuntimeRelease)(deps.home);
    runtime_default = { version: installed.build, protocol: installed.protocol };
  } catch {
    /* Unknown/missing selection is not a claim that no runtime is installed. */
  }
  const groups = new Map<string, HostUpdateCatalogue['runtimes']['versions'][number]>();
  let complete: boolean;
  try {
    const bindings = deps.runtimes.live(4097);
    complete = bindings.length <= 4096;
    for (const binding of bindings.slice(0, 4096)) {
      const key = JSON.stringify([binding.build, binding.protocol_major, binding.protocol_minor]);
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= 128) {
          complete = false;
          continue;
        }
        group = {
          version: binding.build,
          protocol: { major: binding.protocol_major, minor: binding.protocol_minor },
          running: 0,
          starting: 0,
          unavailable: 0,
        };
        groups.set(key, group);
      }
      if (binding.state === 'prepared') group.starting++;
      else if (deps.connections.get(binding.runtime_id)) group.running++;
      else group.unavailable++;
    }
  } catch {
    complete = false;
    groups.clear();
  }
  return hostUpdateCatalogueSchema.parse({
    observed_at: Date.now(),
    daemon_version: deps.version,
    runtime_default,
    runtimes: {
      complete,
      versions: [...groups.values()].sort(
        (a, b) =>
          a.version.localeCompare(b.version) ||
          a.protocol.major - b.protocol.major ||
          a.protocol.minor - b.protocol.minor,
      ),
    },
    releases: deps.releases.read(),
  });
}
