import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { restorePath } from '../../src/worktrees/repositories.js';
import { initRepo, sh } from '../helpers/git-fixtures.js';

const roots: string[] = [];
const repo = () => {
  const root = realpathSync(initRepo());
  roots.push(root);
  return root;
};
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

it('restores only the chosen file to the index, preserving staged edits and a staged rename', async () => {
  const root = repo();
  sh(root, 'mv', 'README.md', 'renamed.md');
  writeFileSync(join(root, 'renamed.md'), 'staged\n');
  sh(root, 'add', 'renamed.md');
  const index = sh(root, 'ls-files', '--stage');
  writeFileSync(join(root, 'renamed.md'), 'unstaged\n');
  writeFileSync(join(root, 'unrelated.txt'), 'keep\n');
  await restorePath(root, root, 'renamed.md', false);
  expect(readFileSync(join(root, 'renamed.md'), 'utf8')).toBe('staged\n');
  expect(sh(root, 'ls-files', '--stage')).toBe(index);
  expect(existsSync(join(root, 'README.md'))).toBe(false);
  expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('keep\n');
});

it('recreates a deleted tracked file and its missing parent directory', async () => {
  const root = repo();
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'folder', 'file'), 'original');
  sh(root, 'add', '.');
  sh(root, 'commit', '-m', 'folder');
  rmSync(join(root, 'folder'), { recursive: true });
  await restorePath(root, root, 'folder/file', false);
  expect(readFileSync(join(root, 'folder', 'file'), 'utf8')).toBe('original');
});

it('requires deletion consent and deletes just the literal untracked filename', async () => {
  const root = repo();
  const name = ':(glob)*.txt';
  writeFileSync(join(root, name), 'discard');
  writeFileSync(join(root, 'keep.txt'), 'keep');
  await expect(restorePath(root, root, name, false)).rejects.toMatchObject({
    code: 'restore_requires_deletion',
  });
  expect(existsSync(join(root, name))).toBe(true);
  await restorePath(root, root, name, true);
  expect(existsSync(join(root, name))).toBe(false);
  expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
});

it('rejects stale deletion consent when the file becomes tracked', async () => {
  const root = repo();
  writeFileSync(join(root, 'README.md'), 'keep this edit');
  await expect(restorePath(root, root, 'README.md', true)).rejects.toMatchObject({
    code: 'restore_changed',
  });
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('keep this edit');
});

it('refuses directory selections, escaped paths, and symlinked parents', async () => {
  const root = repo();
  const outside = repo();
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'folder', 'file'), 'original');
  sh(root, 'add', '.');
  sh(root, 'commit', '-m', 'folder');
  writeFileSync(join(root, 'folder', 'file'), 'keep');
  await expect(restorePath(root, root, 'folder', true)).rejects.toMatchObject({
    code: 'restore_unavailable',
  });
  await expect(restorePath(root, root, '../outside', true)).rejects.toMatchObject({
    code: 'path_outside_repository',
  });
  rmSync(join(root, 'folder'), { recursive: true });
  symlinkSync(outside, join(root, 'folder'));
  await expect(restorePath(root, root, 'folder/file', false)).rejects.toMatchObject({
    code: 'path_outside_repository',
  });
  expect(existsSync(join(outside, 'file'))).toBe(false);
});

it('deletes an untracked symlink without touching its target', async () => {
  const root = repo();
  symlinkSync(join(root, 'README.md'), join(root, 'link'));
  await restorePath(root, root, 'link', true);
  expect(existsSync(join(root, 'link'))).toBe(false);
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# fixture\n');
});
