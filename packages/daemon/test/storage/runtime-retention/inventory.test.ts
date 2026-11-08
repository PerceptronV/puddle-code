import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  RuntimeFilesystemInventory,
  type RuntimeInventorySnapshot,
} from '../../../src/storage/runtime-retention/inventory.js';
import { RUNTIME_INVENTORY_LIMITS } from '../../../src/storage/runtime-retention/limits.js';
import { runtimeStorageCategory } from '../../../src/storage/runtime-retention/paths.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture(options: ConstructorParameters<typeof RuntimeFilesystemInventory>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'puddle-runtime-inventory-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const inventory = new RuntimeFilesystemInventory(root, options);
  cleanups.push(() => inventory.close());
  const put = (name: string, content: string) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  return { root, inventory, put };
}
async function finish(inventory: RuntimeFilesystemInventory) {
  const passes: RuntimeInventorySnapshot[] = [];
  for (let index = 0; index < 200; index++) {
    const next = await inventory.step();
    passes.push(next);
    if (next.state !== 'scanning') return { result: next, passes };
  }
  throw new Error('Inventory did not terminate within bounded fixture passes');
}

it('accounts known owner files incrementally without reading or changing their contents', async () => {
  const f = fixture({ limits: { passEntries: 2 } });
  const segment = randomUUID(),
    generation = randomUUID();
  const raw = f.put(`logs/${segment}/agent.${generation}.log`, 'raw');
  f.put(`segments/${segment}.agent.${generation}.json`, 'checkpoint');
  f.put(`screens/${segment}/agent.terminal.json`, 'screen');
  f.put('launch.json', 'metadata');
  f.put('native-turns.json', 'observations');
  f.put('.native-turns-0.tmp', 'pending-native');
  f.put('shell-hooks/zsh/.zshrc', 'pinned');
  f.put(`logs/${segment}/shell-history`, 'history');
  f.put('hook-state/turn.json', 'native-state');
  f.put(`events.json.${randomUUID()}.tmp`, 'pending');
  const { result, passes } = await finish(f.inventory);
  expect(passes.length).toBeGreaterThan(1);
  expect(passes.every((pass) => pass.pass.entries <= 2)).toBe(true);
  expect(result).toMatchObject({
    state: 'complete',
    files: 10,
    bytes: {
      rawLogs: 3,
      checkpoints: 10,
      screens: 6,
      metadata: 20,
      protected: 25,
      temporary: 21,
      unknown: 0,
    },
  });
  expect(readFileSync(raw, 'utf8')).toBe('raw');
  expect(readdirSync(join(f.root, 'logs', segment))).toHaveLength(2);
});

it('caches observations until explicit restart rather than polling or claiming fresh bytes', async () => {
  const f = fixture();
  const file = f.put('state.json', 'old');
  const first = (await finish(f.inventory)).result;
  writeFileSync(file, 'new-longer', { mode: 0o600 });
  const cached = await f.inventory.step();
  expect(cached.finishedAt).toBe(first.finishedAt);
  expect(cached.pass).toEqual({ entries: 0, nameBytes: 0 });
  expect(cached.bytes.metadata).toBe(3);
  cached.bytes.metadata = 1000;
  expect(f.inventory.snapshot().bytes.metadata).toBe(3);
  await f.inventory.restart();
  expect((await finish(f.inventory)).result.bytes.metadata).toBe(10);
});

it('terminates oversized directories as incomplete with bounded retained work', async () => {
  const f = fixture({ limits: { entries: 4, passEntries: 2 } });
  for (let index = 0; index < 20; index++) f.put(`hook-state/${index}.json`, 'x');
  const { result, passes } = await finish(f.inventory);
  expect(result).toMatchObject({ state: 'incomplete', entries: 4, issues: { limit: 1 } });
  expect(passes.every((pass) => pass.pass.entries <= 2)).toBe(true);
  expect(result.files).toBeLessThan(20);
  expect(readdirSync(join(f.root, 'hook-state'))).toHaveLength(20);
});

it('bounds per-pass name bytes and retains the next entry for a later pass', async () => {
  const f = fixture({ limits: { passNameBytes: 35 } });
  for (let index = 0; index < 6; index++) f.put(`hook-state/${index}.json`, 'x');
  const { result, passes } = await finish(f.inventory);
  expect(result.state).toBe('complete');
  expect(result.files).toBe(6);
  expect(passes.length).toBeGreaterThan(1);
  expect(passes.every((pass) => pass.pass.nameBytes <= 35)).toBe(true);
});

it.each([
  { nameBytes: 20 },
  { passNameBytes: 4 },
  { pathBytes: 4 },
  { directories: 1 },
  { depth: 1 },
])('reports budget exhaustion without claiming complete accounting (%j)', async (limits) => {
  const f = fixture({ limits });
  f.put('hook-state/long-name.json', 'must-stay');
  const { result } = await finish(f.inventory);
  expect(result.state).toBe('incomplete');
  expect(result.issues.limit).toBeGreaterThan(0);
  expect(readFileSync(join(f.root, 'hook-state/long-name.json'), 'utf8')).toBe('must-stay');
});

it('yields on its cooperative deadline between entries', async () => {
  let time = 0;
  const f = fixture({ limits: { passMs: 1 }, clock: () => (time += 0.25) });
  for (let index = 0; index < 12; index++) f.put(`hook-state/${index}.json`, 'x');
  const { result, passes } = await finish(f.inventory);
  expect(result.state).toBe('complete');
  expect(passes.length).toBeGreaterThan(3);
  expect(passes.every((pass) => pass.pass.entries <= 3)).toBe(true);
});

it('never traverses symlink entries and reports their missing accounting', async () => {
  const f = fixture();
  const external = fixture();
  external.put('state.json', 'outside-secret');
  symlinkSync(external.root, join(f.root, 'logs'));
  symlinkSync(join(external.root, 'state.json'), join(f.root, 'state.json'));
  const { result } = await finish(f.inventory);
  expect(result).toMatchObject({ state: 'incomplete', files: 0, issues: { unsafe: 2 } });
  expect(result.bytes.metadata).toBe(0);
  expect(readFileSync(join(external.root, 'state.json'), 'utf8')).toBe('outside-secret');
});

it('counts unknown regular files separately and does not descend unknown directories', async () => {
  const f = fixture();
  f.put('unexpected.json', 'unknown');
  f.put('provider-native/conversation', 'protected-native');
  const { result } = await finish(f.inventory);
  expect(result).toMatchObject({
    state: 'incomplete',
    files: 1,
    bytes: { unknown: 7 },
    issues: { unknown: 2 },
  });
  expect(runtimeStorageCategory(`unexpected.json.${randomUUID()}.tmp`, false)).toBe('unknown');
  expect(readFileSync(join(f.root, 'provider-native/conversation'), 'utf8')).toBe(
    'protected-native',
  );
});

it('refuses replaced directory identity between passes instead of combining old and new trees', async () => {
  const f = fixture({ limits: { passEntries: 1 } });
  f.put('hook-state/one.json', 'old');
  expect((await f.inventory.step()).state).toBe('scanning');
  renameSync(join(f.root, 'hook-state'), join(f.root, 'moved'));
  f.put('hook-state/two.json', 'new');
  const { result } = await finish(f.inventory);
  expect(result.state).toBe('incomplete');
  expect(result.issues.changed).toBeGreaterThan(0);
});

it('does not treat missing, shared or hard-linked entries as fully accounted', async () => {
  const missing = fixture();
  rmSync(missing.root, { recursive: true });
  expect((await finish(missing.inventory)).result).toMatchObject({
    state: 'incomplete',
    issues: { unavailable: 1 },
  });
  const shared = fixture();
  chmodSync(shared.root, 0o755);
  expect((await finish(shared.inventory)).result).toMatchObject({
    state: 'incomplete',
    issues: { unsafe: 1 },
  });
  const linked = fixture();
  const original = linked.put('state.json', 'shared-inode');
  linkSync(original, join(linked.root, 'events.json'));
  expect((await finish(linked.inventory)).result).toMatchObject({
    state: 'incomplete',
    files: 0,
    issues: { unsafe: 2 },
  });
});

it('reports sparse logical sizes without reading contents or charging them as scan work', async () => {
  const f = fixture();
  const file = f.put('events.json', '');
  truncateSync(file, 1024 ** 3);
  const { result } = await finish(f.inventory);
  expect(result).toMatchObject({ state: 'complete', files: 1, bytes: { metadata: 1024 ** 3 } });
  expect(result.nameBytes).toBeLessThan(100);
});

it('coalesces concurrent passes and closes a partial cursor without rewriting data', async () => {
  const f = fixture({ limits: { passEntries: 1 } });
  f.put('hook-state/one.json', 'one');
  f.put('hook-state/two.json', 'two');
  const first = f.inventory.step();
  expect(f.inventory.step()).toBe(first);
  await first;
  await f.inventory.close();
  expect((await f.inventory.step()).state).toBe('closed');
  await f.inventory.restart();
  expect((await finish(f.inventory)).result).toMatchObject({ state: 'complete', files: 2 });
});

it('rejects unbounded options rather than silently overriding production limits', () => {
  for (const value of [0, -1, NaN, Infinity, RUNTIME_INVENTORY_LIMITS.entries + 1])
    expect(() => fixture({ limits: { entries: value } })).toThrow(
      'Invalid runtime inventory limit',
    );
});

it('recognises actual writer temporary and service names while keeping provider state protected', () => {
  const id = randomUUID(),
    generation = randomUUID();
  for (const path of [
    `events.json.${'a'.repeat(64)}.tmp`,
    `events.json.${randomUUID()}.tmp`,
    `segments/${id}.agent.${generation}.json.${randomUUID()}.tmp`,
    `logs/${id}/agent.${generation}.log.tmp-1234`,
    `screens/${id}/shell-1.terminal.json.tmp-1234-0`,
  ])
    expect(runtimeStorageCategory(path, false)).toBe('temporary');
  expect(runtimeStorageCategory(`puddler-01234567-${id}.service`, false)).toBe('metadata');
  expect(runtimeStorageCategory('hook-state/.puddle-turn-nonce.json', false)).toBe('protected');
  expect(runtimeStorageCategory(`logs/${id}/shell-history`, false)).toBe('protected');
});

it('accepts actual pinned helper and shell-hook modes as protected accounting', async () => {
  const f = fixture();
  const helper = f.put('helpers/agent-hook.mjs', 'helper');
  chmodSync(helper, 0o400);
  f.put('shell-hooks/bash/bashrc.bash', 'shell-hook');
  expect((await finish(f.inventory)).result).toMatchObject({
    state: 'complete',
    files: 2,
    bytes: { protected: 16 },
  });
});

it('accounts only the fixed bounded runtime persistence slot names as temporary', async () => {
  const f = fixture();
  f.put('.journal-0.tmp', 'pending');
  f.put('.state-0.tmp', 'state');
  f.put('segments/.checkpoint-0.tmp', 'first');
  f.put('segments/.checkpoint-63.tmp', 'last');
  f.put('screens/.screen-write-0.tmp', 'screen');
  f.put('screens/.screen-write-1.tmp', 'screen');
  expect((await finish(f.inventory)).result).toMatchObject({
    state: 'complete',
    files: 6,
    bytes: { temporary: 33 },
  });
  for (const path of [
    '.journal-1.tmp',
    '.state-1.tmp',
    'screens/.screen-write-2.tmp',
    'screens/.screen-write-00.tmp',
    'segments/.checkpoint-64.tmp',
    'segments/.checkpoint-00.tmp',
  ])
    expect(runtimeStorageCategory(path, false)).toBe('unknown');
});
