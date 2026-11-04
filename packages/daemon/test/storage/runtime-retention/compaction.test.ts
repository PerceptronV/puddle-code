import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeLogRetention } from '../../../src/storage/runtime-retention/compaction.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { runtimeBindingIdentity } from '../../../src/runtime/transport/connections.js';
import { CollectionBudget } from '../../../src/host/installation/collection/budget.js';
import { retireRuntimeRelease } from '../../../src/host/installation/collection/retirement/runtimes.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
  const f = runtimeDatabase();
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'exited' WHERE runtime_id = ?")
    .run(f.binding.runtime_id);
  const binding = f.runtimes.get(f.binding.runtime_id)!;
  atomicPrivateJson(join(f.directory, 'retired.json'), {
    format: 1,
    identity: runtimeBindingIdentity(binding),
  });
  const segment = randomUUID();
  const directory = join(f.directory, 'logs', segment);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data = Buffer.concat([Buffer.alloc(64 * 1024, 1), Buffer.alloc(256 * 1024, 2)]);
  const file = (name = `agent.${randomUUID()}.log`) => {
    const path = join(directory, name);
    writeFileSync(path, data, { mode: 0o600 });
    const old = new Date(Date.now() - 4 * 86400_000);
    utimesSync(path, old, old);
    return path;
  };
  const errors: unknown[] = [];
  const retention = new RuntimeLogRetention({
    home: f.home,
    runtimes: f.runtimes,
    retentionDays: () => 3,
    onError: (error) => errors.push(error),
  });
  cleanups.push(async () => {
    await retention.close();
    await f.reconciler.close();
    f.db.close();
  });
  const retire = (boot: string) =>
    retireRuntimeRelease(
      f.home,
      f.runtimes,
      binding.runtime_id,
      boot,
      () => {},
      async () => {
        throw new Error('No supervisor expected');
      },
      new CollectionBudget(),
    );
  return {
    ...f,
    binding,
    directory,
    data,
    file,
    errors,
    retention,
    retire,
    sweep: (guard = () => {}) =>
      retention.sweep(guard, performance.now() + 5000, new CollectionBudget()),
    async prove() {
      await retire(randomUUID());
      await retire(randomUUID());
    },
  };
}

it('requires a verified later-boot retirement and preserves exact replay tails and unrelated files', async () => {
  const f = fixture();
  const log = f.file();
  const unknown = f.file('unknown.log');
  const history = f.file('shell-history');
  await f.sweep();
  expect(readFileSync(log)).toEqual(f.data);
  const boot = randomUUID();
  await f.retire(boot);
  await f.sweep();
  expect(readFileSync(log)).toEqual(f.data);
  await f.retire(randomUUID());
  await f.sweep();
  expect(readFileSync(log)).toEqual(f.data.subarray(64 * 1024));
  expect(readFileSync(unknown)).toEqual(f.data);
  expect(readFileSync(history)).toEqual(f.data);
  expect(f.errors).toEqual([]);
});

it.each(['runtime-launch', 'runtime-dispatch', 'runtime'])(
  'never compacts while %s is owned',
  async (scope) => {
    const f = fixture();
    const log = f.file();
    await f.prove();
    const claim = acquireHostClaim(f.home, `${scope}:${f.binding.runtime_id}`);
    try {
      await f.sweep();
    } finally {
      claim.release();
    }
    expect(readFileSync(log)).toEqual(f.data);
    expect(f.errors).toHaveLength(1);
    for (const prefix of ['runtime-launch', 'runtime-dispatch', 'runtime'])
      acquireHostClaim(f.home, `${prefix}:${f.binding.runtime_id}`).release();
  },
);

it('refuses changed retirement evidence during copying and removes only its temporary file', async () => {
  const f = fixture();
  const log = f.file();
  await f.prove();
  let changed = false;
  await f.sweep(() => {
    if (!changed && readdirSync(f.directory).some((name) => name.includes('.retention-'))) {
      changed = true;
      const receipt = join(f.directory, '../../release-retirement.json');
      writeFileSync(receipt, readFileSync(receipt, 'utf8') + '\n');
    }
  });
  expect(changed).toBe(true);
  expect(readFileSync(log)).toEqual(f.data);
  expect(readdirSync(f.directory)).toEqual([log.slice(log.lastIndexOf('/') + 1)]);
});

it('continues one bounded cursor across maintenance passes without restarting its prefix', async () => {
  const f = fixture();
  const files = Array.from({ length: 10 }, () => f.file());
  await f.prove();
  expect(await f.sweep()).toBe(true);
  expect(files.filter((path) => statSync(path).size === 256 * 1024)).toHaveLength(8);
  for (let pass = 0; pass < 4 && (await f.sweep()); pass++) {
    /* Continue the bounded cursor. */
  }
  expect(files.every((path) => statSync(path).size === 256 * 1024)).toBe(true);
  expect(f.errors).toEqual([]);
});

it('retains an unsupported runtime history contract even with a valid retirement receipt', async () => {
  const f = fixture();
  const log = f.file();
  f.db
    .prepare('UPDATE runtime_bindings SET protocol_major = 999 WHERE runtime_id = ?')
    .run(f.binding.runtime_id);
  await f.prove();
  await f.sweep();
  expect(readFileSync(log)).toEqual(f.data);
  expect(f.errors).toHaveLength(1);
});

it('validates database inventory identifiers before constructing any owner path or claim', async () => {
  const f = fixture();
  const retention = new RuntimeLogRetention({
    home: f.home,
    runtimes: {
      get: () => null,
      releaseReferences: () => [{ runtime_id: '../unknown', release_path: f.home }],
    },
    retentionDays: () => 3,
  });
  try {
    await expect(
      retention.sweep(() => {}, performance.now() + 5000, new CollectionBudget()),
    ).rejects.toThrow();
  } finally {
    await retention.close();
  }
});
