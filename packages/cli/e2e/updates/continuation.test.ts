import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PROTOCOL_VERSION, hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { offlineUpdateFixture } from '../helpers/host-updates.js';

function fixture() {
  const f = offlineUpdateFixture(PROTOCOL_VERSION);
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
  atomicPrivateJson(join(release, 'HOST_CAPABILITIES.json'), hostReleaseCapabilities('0.4.0', 0));
  // A deterministic dispatcher fixture exercises the built CLI/helper process boundary.
  // It records acceptance then loses its reply; no real host service or daemon is started.
  writeFileSync(
    join(release, 'daemon/host-update.mjs'),
    `
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--home' || args[2] !== '--operation' || args[4] !== '--dispatch-recovery') process.exit(2);
const home = args[1], id = args[3], revision = Number(args[5]);
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
console.log(JSON.stringify(job));
console.error('private fixture diagnostic');
process.exit(1);
`,
  );
  return { ...f, operation, release };
}

it.each(['local', 'ssh'] as const)(
  'continues once through the built %s CLI without a daemon and reports recorded acceptance after a lost worker reply',
  async (kind) => {
    const f = fixture();
    const args = [
      'updates',
      ...(kind === 'ssh' ? ['user@fixture'] : []),
      '--operation',
      f.operation.id,
    ];
    const continued = await f.run('index.js', [...args, '--continue'], '', kind === 'local');
    expect(continued.code, continued.stderr).toBe(0);
    const attempt = readUpdateRecoveryAttempts(f.home, f.operation.id).attempts[0]!;
    const output = continued.stdout + continued.stderr;
    expect(output).toContain(`recorded recovery ${attempt.job.id}: accepted for dispatch`);
    expect(output).toContain('not yet verified complete');
    expect(output).not.toContain('private fixture diagnostic');
    expect(output).not.toContain('node_path');
    const observed = await f.run('index.js', args, '', kind === 'local');
    expect(observed.code, observed.stderr).toBe(0);
    expect(observed.stdout + observed.stderr).toContain(attempt.job.id);
    expect(readFileSync(join(f.home, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
      1,
    );
  },
);

it('observes the exact accepted revision after a repeated helper request without dispatching again', async () => {
  const f = fixture();
  const request_id = randomUUID();
  const request = JSON.stringify({
    t: 'host-update',
    request_id,
    command: {
      action: 'recover',
      strategy: 'continue',
      reference: { id: f.operation.id, revision: f.operation.revision },
    },
  });
  const first = await f.run('host-control.mjs', ['--continue-update'], request, true);
  const repeated = await f.run('host-control.mjs', ['--continue-update'], request, true);
  expect(JSON.parse(first.stdout)).toEqual(JSON.parse(repeated.stdout));
  expect(JSON.parse(first.stdout)).toMatchObject({
    t: 'host-update-result',
    request_id,
    result: { ok: true, recovery: { consumed: false } },
  });
  expect(readFileSync(join(f.home, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it.each(['old-metadata', 'unverified-stage', 'unpinned-node'])(
  'refuses %s before invoking a recovery worker',
  async (damage) => {
    const f = fixture();
    if (damage === 'old-metadata') {
      const capabilities = hostReleaseCapabilities('0.4.0', 0);
      capabilities.application.minor = 11;
      atomicPrivateJson(join(f.release, 'HOST_CAPABILITIES.json'), capabilities);
    } else if (damage === 'unverified-stage') {
      atomicPrivateJson(join(f.release, '.puddle-stage.json'), {
        ...f.operation.stages[0]!.record,
        checksum_verified: false,
      });
    } else {
      rmSync(join(f.release, 'bin/node'));
      symlinkSync(process.execPath, join(f.release, 'bin/node'));
    }
    const before = readFileSync(f.ledger);
    const result = await f.run(
      'index.js',
      ['updates', '--operation', f.operation.id, '--continue'],
      '',
      true,
    );
    expect(result.code).not.toBe(0);
    expect(readFileSync(f.ledger)).toEqual(before);
    expect(readUpdateRecoveryAttempts(f.home, f.operation.id).attempts).toEqual([]);
  },
);
