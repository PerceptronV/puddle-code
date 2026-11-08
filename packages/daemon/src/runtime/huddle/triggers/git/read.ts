import { realpath } from 'node:fs/promises';
import { posix, relative } from 'node:path';
import {
  HUDDLE_GIT_LIMITS,
  huddleGitRefSchema,
  huddleGitSnapshotSchema,
  type HuddleGitRef,
} from '@puddle/shared';
import { git, GitError } from '../../../../git/exec.js';
import { requireTriggerDirectory } from '../worktree.js';
import type { GitDefinition } from './definitions.js';

export interface GitRepositoryIdentity {
  repository: string;
  gitDirectory: string;
  commonDirectory: string;
}
function environment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}
export function readGit(repository: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return git(['--no-pager', ...args], {
    cwd: repository,
    signal,
    timeoutMs: HUDDLE_GIT_LIMITS.commandMs,
    maxOutputBytes: 2 * 1024 * 1024,
    killSignal: 'SIGKILL',
    env: environment(),
  });
}
export async function identifyGitRepository(
  definition: GitDefinition,
  signal: AbortSignal,
): Promise<GitRepositoryIdentity> {
  requireTriggerDirectory(
    definition.worktree,
    relative(definition.worktree, definition.repository) || '.',
  );
  if (
    (await realpath(definition.worktree)) !== definition.worktree ||
    (await realpath(definition.repository)) !== definition.repository
  )
    throw new Error('Git worktree/repository moved');
  const lines = (
    await readGit(
      definition.repository,
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--absolute-git-dir',
        '--git-common-dir',
      ],
      signal,
    )
  ).split('\n');
  if (lines.length !== 3)
    throw new Error('Git repository identity is not a bounded three-path result');
  const paths = await Promise.all(lines.map((path) => realpath(path)));
  signal.throwIfAborted();
  if (paths[0] !== definition.repository)
    throw new Error('Choose the exact Git repository root inside the worktree');
  return { repository: paths[0]!, gitDirectory: paths[1]!, commonDirectory: paths[2]! };
}
export function sameGitRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity) {
  return (
    left.repository === right.repository &&
    left.gitDirectory === right.gitDirectory &&
    left.commonDirectory === right.commonDirectory
  );
}

export async function readGitRefs(
  repository: string,
  prefixes: string[],
  signal: AbortSignal,
): Promise<HuddleGitRef[]> {
  if (!prefixes.length) return [];
  const raw = await readGit(
    repository,
    [
      'for-each-ref',
      `--count=${HUDDLE_GIT_LIMITS.refs + 1}`,
      '--format=%(refname)%00%(objectname)%00%(symref)',
      ...prefixes,
    ],
    signal,
  );
  if (!raw) return [];
  const lines = raw.split('\n');
  if (lines.length > HUDDLE_GIT_LIMITS.refs)
    throw new Error('Git observation exceeds 4096 refs in the selected namespaces');
  return lines.map((line) => {
    const fields = line.split('\0');
    if (fields.length !== 3) throw new Error('Malformed Git ref observation');
    return huddleGitRefSchema.parse({ ref: fields[0], oid: fields[1], target: fields[2] || null });
  });
}
async function headTarget(repository: string, signal: AbortSignal) {
  try {
    return await readGit(repository, ['symbolic-ref', '--quiet', 'HEAD'], signal);
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return null;
    throw error;
  }
}
export async function readGitHead(repository: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = await headTarget(repository, signal);
    let oid: string | null;
    try {
      oid = await readGit(repository, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal);
    } catch (error) {
      if (target && error instanceof GitError && error.exitCode === 1) oid = null;
      else throw error;
    }
    if ((await headTarget(repository, signal)) === target)
      return huddleGitRefSchema.parse({ ref: 'HEAD', oid, target });
  }
  throw new Error('Git HEAD changed repeatedly during observation');
}
export function gitSnapshot(
  definition: GitDefinition,
  refs: HuddleGitRef[],
  head: HuddleGitRef | null,
) {
  const matched = refs.filter((item) =>
    definition.refs.some((pattern) => posix.matchesGlob(item.ref, pattern)),
  );
  if (matched.length > HUDDLE_GIT_LIMITS.matched)
    throw new Error('Git trigger matches more than 1024 refs; narrow its globs');
  return huddleGitSnapshotSchema.parse(
    [...matched, ...(definition.head && head ? [head] : [])].sort((a, b) =>
      a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0,
    ),
  );
}
