import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  hostReleaseCapabilities,
  type HostReleaseCapabilities,
  type HostStageReceipt,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
export function candidateFixture(
  component: 'daemon' | 'runtime' = 'daemon',
  capabilities: HostReleaseCapabilities = hostReleaseCapabilities('0.4.0'),
) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-preflight-'));
  homes.push(home);
  const store = new HostUpdateOperations(home);
  const root = join(home, 'bin/versions', `${capabilities.version}~ABC123`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const record = {
    format: 1 as const,
    component,
    generation: `${capabilities.version}~ABC123`,
    version: capabilities.version,
    protocol: component === 'daemon' ? capabilities.application : capabilities.runtime,
    archive_sha256: digest('verified fixture archive'),
    tree_sha256: digest('fixture tree'),
    checksum_verified: true,
  };
  const stage: HostStageReceipt = { record, digest: digest(`${JSON.stringify(record)}\n`) };
  atomicPrivateJson(join(root, '.puddle-stage.json'), record);
  writeFileSync(join(root, 'HOST_CAPABILITIES.json'), JSON.stringify(capabilities));
  let operation = store.begin([{ component, version: capabilities.version }]).operation;
  operation = store.staged(operation, stage);
  return { home, root, store, operation, stage, capabilities };
}
