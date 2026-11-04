import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';

import { continuationFixture as fixture } from '../helpers/update-continuation.js';

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
