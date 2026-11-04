import { constants, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION, hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { offlineUpdateFixture } from './host-updates.js';

export function continuationFixture(protocol: { major: number; minor: number } = PROTOCOL_VERSION) {
  const f = offlineUpdateFixture(protocol);
  const worker = f.store.claimExecution(
    f.operation,
    f.operation.dispatch_id!,
    f.operation.preflight!,
  );
  const operation = worker.failed('Interrupted fixture update');
  worker.release();
  const stage = operation.stages[0]!;
  const release = join(f.home, 'bin/versions', stage.record.generation);
  mkdirSync(release, { recursive: true, mode: 0o700 });
  mkdirSync(join(release, 'bin'), { recursive: true });
  mkdirSync(join(release, 'daemon'));
  copyFileSync(process.execPath, join(release, 'bin/node'), constants.COPYFILE_FICLONE);
  writeFileSync(join(release, 'daemon/install.sh'), '');
  atomicPrivateJson(join(release, '.puddle-stage.json'), stage.record);
  atomicPrivateJson(join(release, 'HOST_CAPABILITIES.json'), {
    ...hostReleaseCapabilities('0.4.0', 0),
    application: protocol,
  });
  // A deterministic dispatcher fixture exercises the built CLI/helper process boundary.
  // It records acceptance then loses its reply; no real host service or daemon is started.
  writeFileSync(
    join(release, 'daemon/host-update.mjs'),
    `
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { watchUpdateParticipation } from ${JSON.stringify(new URL('../../../shared/dist/node/installation/participation.js', import.meta.url).href)};
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--home' || args[2] !== '--operation' || !['--dispatch-recovery', '--participating-recovery'].includes(args[4])) process.exit(2);
const home = args[1], id = args[3], revision = Number(args[5]);
const participation = args[4] === '--participating-recovery' ? watchUpdateParticipation(process.stdin) : null;
if (participation) process.stdin.resume();
async function checkpoint(name, cancellable) {
  fs.writeFileSync(path.join(home, name), 'ready');
  while (fs.existsSync(path.join(home, 'hold-' + name)) && !(cancellable && participation?.signal.aborted)) await delay(10);
}
await checkpoint('before-dispatch', true);
if (participation?.signal.aborted) {
  fs.writeFileSync(path.join(home, 'cancelled-dispatch'), 'cancelled');
  process.exit(4);
}
const file = path.join(home, 'updates/operations.json');
const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
const operation = ledger.current;
if (operation.id !== id || operation.revision !== revision) process.exit(3);
fs.appendFileSync(path.join(home, 'dispatches.jsonl'), JSON.stringify(args) + '\\n');
operation.revision++;
operation.updated_at = Date.now();
fs.writeFileSync(file, JSON.stringify(ledger) + '\\n', { mode: 0o600 });
const root = path.dirname(path.dirname(process.argv[1]));
const job = { format: 1, id: randomUUID(), operation_id: id, requested_revision: revision,
 revision: operation.revision, original_dispatch_id: operation.dispatch_id, original_worker_id: operation.worker_id,
 preflight: operation.approved, original_worker_digest: '${digest('fixture worker')}', actions_digest: '${digest('fixture steps')}',
 service: { kind: 'systemd', name: 'puddle-recovery-fixture.service', domain: null,
 release_path: root, node_path: process.execPath, entry_path: process.argv[1], installer_path: path.join(root, 'daemon/install.sh') } };
const directory = path.join(home, 'updates/jobs', id, 'recovery');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(directory, 'attempts.json'), JSON.stringify({ format: 1, attempts: [{ job, execution: null }] }) + '\\n', { mode: 0o600 });
await checkpoint('after-acceptance', false);
fs.writeFileSync(path.join(home, 'finished-dispatch'), 'finished');
console.log(JSON.stringify(job));
console.error('private fixture diagnostic');
process.exit(1);
`,
  );
  return { ...f, operation, release };
}
