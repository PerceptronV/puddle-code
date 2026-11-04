import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import {
  compatibleRuntimeProtocol,
  runtimeAssetsSchema,
  runtimeIdentitySchema,
  runtimeSupervisorSchema,
} from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import {
  boundedDirectories,
  optionalRecord,
  RELEASE_INVENTORY_LIMIT,
  ReleaseReferenceInventory,
} from './inventory.js';

export async function retainRuntimeReleases(
  index: ReleaseReferenceInventory,
  runtimes: Pick<RuntimeStore, 'releaseReferences' | 'get'>,
): Promise<void> {
  const known = new Set<string>();
  let after = '';
  for (;;) {
    index.requireCurrent();
    const rows = runtimes.releaseReferences(after);
    if (!rows.length) break;
    for (const row of rows) {
      runtimeIdentitySchema.shape.runtime_id.parse(row.runtime_id);
      if (
        row.runtime_id <= after ||
        known.has(row.runtime_id) ||
        known.size === RELEASE_INVENTORY_LIMIT
      )
        throw new Error('Runtime release inventory is not bounded and ordered');
      const binding = runtimes.get(row.runtime_id);
      if (
        !binding ||
        binding.release_path !== row.release_path ||
        !compatibleRuntimeProtocol({ major: binding.protocol_major, minor: binding.protocol_minor })
      )
        throw new Error('Runtime release identity or protocol is unknown');
      index.add(row.release_path, `runtime:${row.runtime_id}`);
      privatePath(join(index.home, 'runtimes', row.runtime_id), true);
      known.add(row.runtime_id);
      after = row.runtime_id;
    }
    await setImmediate();
  }
  for (const id of await boundedDirectories(join(index.home, 'runtimes'), index.requireCurrent)) {
    if (!known.has(id)) throw new Error('Unbound runtime files prevent release collection');
    const directory = join(index.home, 'runtimes', id);
    privatePath(directory, true);
    const assets = optionalRecord(join(directory, 'assets.json'), 32 * 1024);
    if (assets) index.executable(runtimeAssetsSchema.parse(assets).node_path, `helper:${id}`);
    const value = optionalRecord(join(directory, 'supervisor.json'), 32 * 1024);
    if (value) {
      const service = runtimeSupervisorSchema.parse(value);
      const binding = runtimes.get(id);
      if (
        !binding ||
        JSON.stringify(service.identity) !== JSON.stringify(runtimeBindingIdentity(binding))
      )
        throw new Error('Runtime service identity changed');
      index.executable(service.node_path, `runtime-service:${id}`);
      index.executable(service.entry_path, `runtime-service:${id}`);
    }
  }
}
