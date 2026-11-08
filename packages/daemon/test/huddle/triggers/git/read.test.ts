import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { gitFixture } from '../../../helpers/huddle/git.js';
import { gitChanges } from '../../../../src/runtime/huddle/triggers/git/changes.js';
import {
  gitSnapshot,
  identifyGitRepository,
  readGitHead,
  readGitRefs,
} from '../../../../src/runtime/huddle/triggers/git/read.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});
async function fixture() {
  const f = await gitFixture();
  cleanups.push(f.cleanup);
  return f;
}
const signal = () => new AbortController().signal;
it('observes unborn/detached HEAD and same-OID branch switches, including linked worktrees', async () => {
  const f = await fixture();
  expect(await readGitHead(f.worktree, signal())).toEqual({
    ref: 'HEAD',
    oid: null,
    target: 'refs/heads/main',
  });
  await f.command(['commit', '--allow-empty', '-m', 'first']);
  const first = await readGitHead(f.worktree, signal());
  await f.command(['switch', '-c', 'other']);
  const other = await readGitHead(f.worktree, signal());
  expect(gitChanges([first], [other])).toEqual([
    {
      ref: 'HEAD',
      oldOid: first.oid,
      newOid: first.oid,
      oldTarget: 'refs/heads/main',
      newTarget: 'refs/heads/other',
    },
  ]);
  await f.command(['checkout', '--detach']);
  expect(await readGitHead(f.worktree, signal())).toEqual({ ...first, target: null });
  const linked = join(realpathSync(f.home), 'linked');
  await f.command(['worktree', 'add', linked, 'main']);
  const identity = await identifyGitRepository(f.definition, signal());
  const linkedIdentity = await identifyGitRepository(
    { ...f.definition, worktree: linked, repository: linked },
    signal(),
  );
  expect(linkedIdentity.commonDirectory).toBe(identity.commonDirectory);
  expect(linkedIdentity.gitDirectory).not.toBe(identity.gitDirectory);
  expect(await readGitHead(linked, signal())).toEqual(first);
});
it('retains annotated tag object IDs, force updates, deletes and packed refs', async () => {
  const f = await fixture();
  await f.command(['commit', '--allow-empty', '-m', 'first']);
  const first = await readGitHead(f.worktree, signal());
  await f.command(['tag', '-a', 'release', '-m', 'release']);
  const before = await readGitRefs(f.worktree, ['refs/heads/', 'refs/tags/'], signal());
  const tag = before.find((item) => item.ref === 'refs/tags/release')!;
  expect(tag.oid).not.toBe(first.oid);
  await f.command(['pack-refs', '--all', '--prune']);
  expect(await readGitRefs(f.worktree, ['refs/heads/', 'refs/tags/'], signal())).toEqual(before);
  await f.command(['commit', '--allow-empty', '-m', 'second']);
  const second = await readGitHead(f.worktree, signal());
  await f.command(['update-ref', 'refs/heads/main', first.oid!]);
  await f.command(['tag', '-d', 'release']);
  const after = await readGitRefs(f.worktree, ['refs/heads/', 'refs/tags/'], signal());
  expect(gitChanges([second], [await readGitHead(f.worktree, signal())])[0]).toMatchObject({
    oldOid: second.oid,
    newOid: first.oid,
  });
  expect(gitChanges(before, after)).toEqual([
    { ref: tag.ref, oldOid: tag.oid, newOid: null, oldTarget: null, newTarget: null },
  ]);
  expect(gitSnapshot({ ...f.definition, refs: [], head: true }, before, first)).toEqual([first]);
});
it('ignores inherited Git placement overrides and rejects non-root repositories and cancellation', async () => {
  const f = await fixture();
  vi.stubEnv('GIT_DIR', '/missing-git');
  vi.stubEnv('GIT_WORK_TREE', '/missing-worktree');
  expect((await identifyGitRepository(f.definition, signal())).repository).toBe(f.worktree);
  mkdirSync(join(f.worktree, 'child'));
  await expect(
    identifyGitRepository({ ...f.definition, repository: join(f.worktree, 'child') }, signal()),
  ).rejects.toThrow('exact Git repository root');
  const abort = new AbortController();
  abort.abort();
  await expect(readGitRefs(f.worktree, ['refs/heads/'], abort.signal)).rejects.toThrow();
});
it('rejects namespace and matched-ref overflow instead of publishing a truncated snapshot', async () => {
  const f = await fixture();
  await f.command(['commit', '--allow-empty', '-m', 'baseline']);
  const head = await readGitHead(f.worktree, signal());
  const refs = Array.from({ length: 4097 }, (_, i) => ({
    ref: `refs/tags/t${String(i).padStart(4, '0')}`,
    oid: head.oid,
    target: null,
  }));
  expect(() => gitSnapshot(f.definition, refs.slice(0, 1025), head)).toThrow('1024 refs');
  writeFileSync(
    join(f.worktree, '.git/packed-refs'),
    '# pack-refs with: sorted\n' + refs.map((ref) => `${ref.oid} ${ref.ref}\n`).join(''),
  );
  await expect(readGitRefs(f.worktree, ['refs/tags/'], signal())).rejects.toThrow('4096 refs');
});
