import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pruneOwnedTree } from '../../../src/host/installation/tree.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-owned-tree-'));
  homes.push(home);
  const root = join(home, 'quarantine');
  mkdirSync(root, { mode: 0o700 });
  const info = lstatSync(root);
  return { home, root, identity: { device: info.dev, inode: info.ino } };
}

it('bounds deletions and resumes from the exact root without following directory or file links', async () => {
  const f = fixture();
  const user = join(f.home, 'user');
  mkdirSync(user);
  writeFileSync(join(user, 'conversation'), 'keep');
  mkdirSync(join(f.root, 'nested'), { mode: 0o700 });
  symlinkSync(user, join(f.root, 'nested/link'));
  symlinkSync(join(user, 'conversation'), join(f.root, 'file-link'));
  const budget = { remaining: 1 };
  expect(await pruneOwnedTree(f.root, f.identity, () => {}, budget)).toBe(false);
  expect(budget.remaining).toBe(0);
  expect(existsSync(f.root)).toBe(true);
  expect(await pruneOwnedTree(f.root, f.identity, () => {}, { remaining: 512 })).toBe(true);
  expect(readFileSync(join(user, 'conversation'), 'utf8')).toBe('keep');
});

it('refuses writable ancestors before touching their contents', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'keep'), 'keep');
  chmodSync(f.root, 0o777);
  await expect(pruneOwnedTree(f.root, f.identity, () => {}, { remaining: 512 })).rejects.toThrow(
    'identity changed',
  );
  expect(existsSync(join(f.root, 'keep'))).toBe(true);
});

it('rechecks root identity after asynchronous directory inspection', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'keep'), 'keep');
  let checks = 0;
  await expect(
    pruneOwnedTree(
      f.root,
      f.identity,
      () => {
        if (++checks === 2) {
          renameSync(f.root, join(f.home, 'original'));
          symlinkSync(join(f.home, 'original'), f.root);
        }
      },
      { remaining: 512 },
    ),
  ).rejects.toThrow('identity changed');
  expect(readFileSync(join(f.home, 'original/keep'), 'utf8')).toBe('keep');
});

it('refuses unbounded or invalid budgets and excessive directory depth', async () => {
  const f = fixture();
  for (const remaining of [-1, 513, NaN, 0.5])
    await expect(pruneOwnedTree(f.root, f.identity, () => {}, { remaining })).rejects.toThrow(
      'budget',
    );
  let directory = f.root;
  for (let i = 0; i < 65; i++) {
    directory = join(directory, 'd');
    mkdirSync(directory, { mode: 0o700 });
  }
  await expect(pruneOwnedTree(f.root, f.identity, () => {}, { remaining: 512 })).rejects.toThrow(
    'depth limit',
  );
  expect(existsSync(directory)).toBe(true);
});
