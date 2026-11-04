import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson } from '@puddle/shared/node';
import { hostStageRecordSchema } from '@puddle/shared';
import { UNREFERENCED_RELEASE_RETENTION_MS } from '../../src/host/installation/collection/inventory.js';

/** Metadata/executable placeholders only; these files are never executed. */
export function collectionRelease(home: string, generation: string, old = true) {
  const path = join(home, 'bin/versions', generation);
  mkdirSync(join(path, 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(path, 'daemon'), { recursive: true, mode: 0o700 });
  for (const file of [
    'bin/node',
    'daemon/puddler.mjs',
    'daemon/host-update.mjs',
    'daemon/install.sh',
  ])
    writeFileSync(join(path, file), 'fixture only', { mode: 0o600 });
  const record = hostStageRecordSchema.parse({
    format: 1,
    component: 'daemon',
    generation,
    version: generation.split('~')[0],
    protocol: { major: 25, minor: 19 },
    archive_sha256: 'a'.repeat(64),
    tree_sha256: 'b'.repeat(64),
    checksum_verified: true,
  });
  const file = join(path, '.puddle-stage.json');
  atomicPrivateJson(file, record);
  if (old) {
    const date = new Date(Date.now() - UNREFERENCED_RELEASE_RETENTION_MS - 60_000);
    utimesSync(file, date, date);
  }
  return { path: realpathSync(path), record };
}
