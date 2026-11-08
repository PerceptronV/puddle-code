import { ReadOnlyDiff } from '../diff/ReadOnlyDiff';
import type { DiffEntry } from '@puddle/shared';
import { useFileAt } from '../../lib/queries/worktree-queries';
import { ApiError } from '../../lib/transport/api';
import { DeletedContent, Note, ReadOnlyView } from '../diff/FileDiffContent';
import { effectiveStatus } from './history-logic';

/**
 * `added` (and the root-commit override, and a `sha^` original that 404s
 * unexpectedly — see `effectiveStatus`): the file's content at `sha`, plain
 * and read-only, no original side.
 */
function AddedAt({
  session,
  sha,
  path,
  root,
}: {
  session: string;
  sha: string;
  path: string;
  root?: string;
}) {
  const file = useFileAt(session, sha, path, { root });
  if (file.isPending) return <Note>…</Note>;
  if (file.error) {
    return <Note>{file.error instanceof Error ? file.error.message : 'Failed to load file'}</Note>;
  }
  if (file.data.binary) return <Note>Binary file</Note>;
  return (
    <ReadOnlyView
      session={session}
      refName={`${sha}:${root ?? ''}`}
      path={path}
      content={file.data.content ?? ''}
    />
  );
}

/** `modified`/`renamed`: `sha^` (original) vs. `sha` (modified), both read-only. */
function ModifiedAt({
  session,
  sha,
  path,
  basePath,
  root,
}: {
  session: string;
  sha: string;
  path: string;
  basePath: string;
  root?: string;
}) {
  const original = useFileAt(session, `${sha}^`, basePath, { root });
  const modified = useFileAt(session, sha, path, { root });

  // Tolerated per the brief even though `effectiveStatus` already keeps a
  // root commit out of this branch: an unexpected 404 on the parent blob
  // degrades to an added-only view instead of an error.
  const originalMissing = original.error instanceof ApiError && original.error.status === 404;
  if (originalMissing) return <AddedAt session={session} sha={sha} path={path} root={root} />;

  if (original.isPending || modified.isPending) return <Note>…</Note>;
  if (original.error) {
    return (
      <Note>
        {original.error instanceof Error ? original.error.message : 'Failed to load original'}
      </Note>
    );
  }
  if (modified.error) {
    return (
      <Note>
        {modified.error instanceof Error ? modified.error.message : 'Failed to load file'}
      </Note>
    );
  }
  if (original.data.binary || modified.data.binary) return <Note>Binary file</Note>;

  return (
    <ReadOnlyDiff
      session={session}
      originalRef={`${sha}^`}
      originalPath={basePath}
      originalContent={original.data.content ?? ''}
      modifiedRef={sha}
      modifiedPath={path}
      modifiedContent={modified.data.content ?? ''}
      root={root}
    />
  );
}

/**
 * The Monaco body for one file in a commit's `show` (SPEC §8): `sha^`→`sha`,
 * read-only, chosen by status. `CommitTabBody` renders it as a centre-editor
 * commit tab; its hooks and Monaco mount only while that tab is active.
 */
export function HistoryFileContent({
  session,
  sha,
  entry,
  isRootCommit,
  root,
}: {
  session: string;
  sha: string;
  entry: DiffEntry;
  isRootCommit: boolean;
  root?: string;
}) {
  switch (effectiveStatus(entry.status, isRootCommit)) {
    case 'added':
      return <AddedAt session={session} sha={sha} path={entry.path} root={root} />;
    case 'deleted':
      return <DeletedContent session={session} against={`${sha}^`} path={entry.path} root={root} />;
    case 'modified':
    case 'renamed':
      return (
        <ModifiedAt
          session={session}
          sha={sha}
          path={entry.path}
          basePath={entry.old_path ?? entry.path}
          root={root}
        />
      );
    default:
      return null;
  }
}
