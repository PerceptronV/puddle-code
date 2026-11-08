import { mkdirSync, writeFileSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { filetreeFixture } from '../../../helpers/huddle/filetree.js';
import {
  scanFiletree,
  filetreeChanges,
} from '../../../../src/runtime/huddle/triggers/filetree/snapshot.js';
import { filetreeDefinitions } from '../../../../src/runtime/huddle/triggers/filetree/definitions.js';
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
function fixture(parameters = {}) {
  const f = filetreeFixture(parameters);
  cleanups.push(f.cleanup);
  return f;
}
it('filters globs and excludes Git, huddle definitions, declared outputs and symlinks', async () => {
  const f = fixture({ include: ['**/*.txt', '.hidden'], outputPaths: ['reports'] });
  for (const path of ['.git', '.puddle/huddle/other', 'reports', 'src', 'node_modules/pkg'])
    mkdirSync(join(f.worktree, path), { recursive: true });
  for (const path of [
    '.git/a.txt',
    '.puddle/huddle/other/a.txt',
    'reports/a.txt',
    'src/a.txt',
    'src/a.ts',
    '.hidden',
    'node_modules/pkg/a.txt',
  ])
    writeFileSync(join(f.worktree, path), 'x');
  symlinkSync(f.home, join(f.worktree, 'outside'));
  const directories = vi.fn();
  const result = await scanFiletree(f.definition, new AbortController().signal, directories);
  expect(result.snapshot.map((file) => file.path)).toEqual(['.hidden', 'src/a.txt']);
  expect(
    [...result.directories].some((path) =>
      /node_modules|reports|huddle|\.git/.test(path.slice(f.worktree.length)),
    ),
  ).toBe(false);
});
it('reports atomic replacement as change, rename as net remove/create and repeated scans as unchanged', async () => {
  const f = fixture();
  writeFileSync(join(f.worktree, 'a.txt'), 'old');
  const scan = () => scanFiletree(f.definition, new AbortController().signal, () => {});
  const first = await scan();
  writeFileSync(join(f.worktree, 'temp'), 'new');
  renameSync(join(f.worktree, 'temp'), join(f.worktree, 'a.txt'));
  const second = await scan();
  expect(filetreeChanges(first.snapshot, second.snapshot)).toEqual([
    { path: 'a.txt', kind: 'change' },
  ]);
  renameSync(join(f.worktree, 'a.txt'), join(f.worktree, 'b.txt'));
  const third = await scan();
  expect(filetreeChanges(second.snapshot, third.snapshot)).toEqual([
    { path: 'a.txt', kind: 'remove' },
    { path: 'b.txt', kind: 'create' },
  ]);
  expect(filetreeChanges(third.snapshot, (await scan()).snapshot)).toEqual([]);
  unlinkSync(join(f.worktree, 'b.txt'));
  expect(filetreeChanges(third.snapshot, (await scan()).snapshot)).toEqual([
    { path: 'b.txt', kind: 'remove' },
  ]);
});
it('bounds matched files and cancellation and rejects a substituted worktree', async () => {
  const f = fixture();
  for (let i = 0; i < 1025; i++) writeFileSync(join(f.worktree, `file-${i}`), 'x');
  await expect(scanFiletree(f.definition, new AbortController().signal, () => {})).rejects.toThrow(
    '1024 matched files',
  );
  const abort = new AbortController();
  abort.abort();
  await expect(scanFiletree(f.definition, abort.signal, () => {})).rejects.toThrow();
  renameSync(f.worktree, f.worktree + '-moved');
  symlinkSync(f.worktree + '-moved', f.worktree);
  expect(() => filetreeDefinitions(f.snapshot, f.activation)).toThrow('resolved worktree binding');
});
