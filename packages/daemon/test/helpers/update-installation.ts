import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostReleaseCapabilities, hostUpdateWorkerSchema, PROTOCOL_VERSION } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { hostInstallationFixture } from '../../../cli/test/helpers/host-installation.js';
import { stageHostComponent } from '../../../cli/src/lib/installation/host/staging.js';
import { HostUpdateOperations } from '../../src/updates/operations/store.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/db/migrations/index.js';

export async function updateInstallation(components: Array<'daemon' | 'runtime'> = ['runtime']) {
  const f = hostInstallationFixture();
  // Exact release resolution requires its own Node file, not a link outside the tree.
  rmSync(join(f.staged, 'bin/node'));
  copyFileSync(process.execPath, join(f.staged, 'bin/node'));
  mkdirSync(join(f.staged, 'daemon'));
  writeFileSync(join(f.staged, 'daemon/puddler.mjs'), '// fake provider-free runtime entry\n');
  const capabilities = hostReleaseCapabilities('1.2.3', DATABASE_SCHEMA_VERSION);
  writeFileSync(join(f.staged, 'HOST_CAPABILITIES.json'), JSON.stringify(capabilities));
  writeFileSync(
    join(f.staged, 'PROTOCOL'),
    `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}\n`,
  );
  writeFileSync(
    f.stagedBinary,
    `#!/bin/sh\nprintf 'puddled 1.2.3 (protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor})\\n'\n`,
  );
  f.pack();
  writeFileSync(
    `${f.tarball}.sha256`,
    `${createHash('sha256').update(readFileSync(f.tarball)).digest('hex')}  ${f.tarball.split('/').pop()}\n`,
  );
  f.install('--component', 'runtime');
  const previous = f.selected('runtime');
  if (components.includes('daemon')) f.install('--component', 'daemon');
  const previousDaemon = components.includes('daemon') ? f.selected('daemon') : null;
  const marker = join(f.puddleHome, 'supervisor');
  writeFileSync(marker, 'launchd\n');
  const store = new HostUpdateOperations(f.puddleHome);
  let operation = store.begin(
    components.map((component) => ({ component, version: '1.2.3' })),
  ).operation;
  const receipts = [];
  for (const component of components) {
    const stage = await stageHostComponent(f.transport, component, {
      version: '1.2.3',
      tarball: f.tarball,
    });
    receipts.push(stage);
    operation = store.staged(operation, stage);
  }
  const receipt = receipts[0]!;
  operation = store.preflight(operation, digest('exact preflight'));
  operation = store.approve(operation, operation.preflight!);
  operation = store.dispatch(operation);
  const job = hostUpdateWorkerSchema.parse({
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    dispatch_revision: operation.revision,
    preflight: operation.preflight,
    kind: 'launchd',
    name: `dev.puddle.update.${operation.id}`,
    domain: 'gui/501',
    release_path: f.staged,
    node_path: process.execPath,
    entry_path: join(f.staged, 'worker.mjs'),
    installer_path: fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)),
    state: 'dispatched',
  });
  return { ...f, receipt, receipts, store, operation, job, previous, previousDaemon, marker };
}
