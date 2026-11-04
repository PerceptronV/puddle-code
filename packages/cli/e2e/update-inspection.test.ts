import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { offlineUpdateFixture as fixture } from './helpers/host-updates.js';

it.each(['local', 'ssh'] as const)(
  'inspects interrupted updates through the built %s CLI without a daemon or application database',
  async (kind) => {
    const f = fixture();
    const before = readFileSync(f.ledger);
    const args = [
      'updates',
      ...(kind === 'ssh' ? ['user@fixture'] : []),
      '--operation',
      f.operation.id,
    ];
    const result = await f.run('index.js', args, '', kind === 'local');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('showing recorded update state');
    expect(result.stdout + result.stderr).toContain(f.operation.id);
    expect(result.stdout + result.stderr).toContain('dispatching');
    for (const action of ['--cancel', '--recover']) {
      const rejected = await f.run('index.js', [...args, action], '', kind === 'local');
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).not.toContain('showing recorded update state');
    }
    expect(readFileSync(f.ledger)).toEqual(before);
    for (const name of ['puddle.db', 'runtime.json', 'token', 'supervisor'])
      expect(existsSync(join(f.home, name))).toBe(false);
  },
);

it('bounds the bootstrap helper input and refuses mutation or fresh-adoption requests', async () => {
  const f = fixture();
  const before = readFileSync(f.ledger);
  const request_id = randomUUID();
  for (const command of [
    {
      action: 'recover',
      reference: { id: f.operation.id, revision: f.operation.revision },
      strategy: 'verify-completion',
    },
    {
      action: 'recover',
      reference: { id: f.operation.id, revision: f.operation.revision },
      strategy: 'continue',
    },
    { action: 'status', id: f.operation.id, adoption_nonce: randomUUID() },
  ]) {
    const result = await f.run(
      'host-control.mjs',
      ['--updates'],
      JSON.stringify({ t: 'host-update', request_id, command }),
      true,
    );
    expect(JSON.parse(result.stdout)).toEqual({
      t: 'host-update-result',
      request_id,
      result: { ok: false, code: 'unsupported', operation: null },
    });
  }
  for (const input of ['{', ' '.repeat(16 * 1024 + 1)]) {
    const result = await f.run('host-control.mjs', ['--updates'], input, true);
    expect(JSON.parse(result.stdout)).toEqual({ t: 'error', code: 'rejected' });
  }
  expect(readFileSync(f.ledger)).toEqual(before);
});

it('keeps offline continuation separate from verification and cancellation', async () => {
  const f = fixture();
  const before = readFileSync(f.ledger);
  for (const command of [
    { action: 'status', id: f.operation.id },
    {
      action: 'cancel',
      reference: { id: f.operation.id, revision: f.operation.revision },
      reason: 'cancelled',
    },
    {
      action: 'recover',
      reference: { id: f.operation.id, revision: f.operation.revision },
      strategy: 'verify-completion',
    },
  ]) {
    const request_id = randomUUID();
    const result = await f.run(
      'host-control.mjs',
      ['--continue-update'],
      JSON.stringify({ t: 'host-update', request_id, command }),
      true,
    );
    expect(JSON.parse(result.stdout)).toEqual({
      t: 'host-update-result',
      request_id,
      result: { ok: false, code: 'unsupported', operation: null },
    });
  }
  expect(readFileSync(f.ledger)).toEqual(before);
});
