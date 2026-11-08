import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';

const fixtures: HuddleLedgerFixture[] = [];
let compiled: string;
beforeAll(async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  compiled = mkdtempSync(join(root, 'node_modules/.huddle-crash-'));
  await build({
    entryPoints: [join(root, 'test/helpers/huddle/crash.ts')],
    outfile: join(compiled, 'crash.cjs'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    bundle: true,
    external: ['better-sqlite3'],
    alias: {
      '@puddle/shared/node': join(root, '../shared/src/node/security.ts'),
      '@puddle/shared': join(root, '../shared/src/index.ts'),
    },
  });
});
afterAll(() => {
  if (compiled) rmSync(compiled, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('huddle crash durability', () => {
  it('retains a consumed dispatch and its one external effect after SIGKILL', () => {
    const f = huddleLedgerFixture();
    fixtures.push(f);
    const event = f.event();
    const invocationId = randomUUID();
    const operationId = randomUUID();
    f.ledger.close();
    const child = spawnSync(
      process.execPath,
      [
        join(compiled, 'crash.cjs'),
        f.home,
        JSON.stringify({
          identity: f.identity,
          event,
          limits: f.settings,
          invocationId,
          operationId,
        }),
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe('SIGKILL');
    f.reopen();
    expect(f.ledger.operations.get(operationId)).toMatchObject({
      state: 'dispatched',
      consumed: true,
    });
    expect(f.ledger.recoverOwnerLoss()).toEqual([event.executionId]);
    expect(f.ledger.operations.get(operationId)).toMatchObject({
      state: 'unknown',
      consumed: true,
    });
    expect(() => f.ledger.operations.dispatch(operationId)).toThrow('not running');
    expect(readFileSync(join(f.home, 'effect.txt'), 'utf8')).toBe('sent\n');
    expect(
      f.ledger.operations.settle(operationId, 'completed', { observed: 'one write' }).consumed,
    ).toBe(true);
    f.reopen();
    expect(f.ledger.recoverOwnerLoss()).toEqual([]);
    expect(readFileSync(join(f.home, 'effect.txt'), 'utf8')).toBe('sent\n');
  });

  it('rejects newer retained state before changing it and keeps state files private', () => {
    const f = huddleLedgerFixture();
    fixtures.push(f);
    f.ledger.close();
    const file = join(f.home, 'runtimes', f.identity.runtimeId, 'huddle.sqlite');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const db = new Database(file);
    db.pragma('user_version = 2');
    db.close();
    const bytes = readFileSync(file);
    expect(() => new HuddleLedger(f.home, f.identity)).toThrow('Unsupported huddle ledger version');
    expect(readFileSync(file)).toEqual(bytes);
  });
});
