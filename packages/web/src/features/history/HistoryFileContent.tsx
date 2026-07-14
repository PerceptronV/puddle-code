import { useEffect, useMemo, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { DiffEntry } from '@puddle/shared';
import { useFileAt } from '../../lib/worktree-queries';
import { ApiError } from '../../lib/api';
import { DeletedContent, Note, ReadOnlyView, viewerUri } from '../diff/FileDiffContent';
import { monaco, THEME_NAME } from '../editor/monaco-setup';
import { effectiveStatus } from './history-logic';

/**
 * `added` (and the root-commit override, and a `sha^` original that 404s
 * unexpectedly — see `effectiveStatus`): the file's content at `sha`, plain
 * and read-only, no original side.
 */
function AddedAt({ session, sha, path }: { session: string; sha: string; path: string }) {
  const file = useFileAt(session, sha, path);
  if (file.isPending) return <Note>…</Note>;
  if (file.error) {
    return <Note>{file.error instanceof Error ? file.error.message : 'Failed to load file'}</Note>;
  }
  if (file.data.binary) return <Note>Binary file</Note>;
  return (
    <ReadOnlyView session={session} refName={sha} path={path} content={file.data.content ?? ''} />
  );
}

/**
 * A read-only Monaco diff between two fixed refs, wholly private models on
 * both sides — never the shared buffer-store, since a sha→sha comparison has
 * no notion of "the current editable draft" (SPEC §8, Task 9). Disposal
 * mirrors FileDiffContent's `ModifiedContent`: the DiffEditorWidget does not
 * auto-detach a disposed model (it logs a BugIndicatingError instead, per
 * that file's comment — monaco 0.55.1), so both `keepCurrent*Model` flags are
 * set and this component detaches (`setModel(null)`) before disposing either
 * model itself, rather than letting the library's own unmount path dispose a
 * still-attached model.
 */
function HistoryDiffEditor({
  session,
  originalRef,
  originalPath,
  originalContent,
  modifiedRef,
  modifiedPath,
  modifiedContent,
}: {
  session: string;
  originalRef: string;
  originalPath: string;
  originalContent: string;
  modifiedRef: string;
  modifiedPath: string;
  modifiedContent: string;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  useEffect(
    () => () => {
      const editor = editorRef.current;
      if (!editor) return;
      const models = editor.getModel();
      editor.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      editorRef.current = null;
    },
    [],
  );

  return (
    <DiffEditor
      originalModelPath={viewerUri('puddle-hist-orig', session, originalRef, originalPath)}
      modifiedModelPath={viewerUri('puddle-hist-mod', session, modifiedRef, modifiedPath)}
      original={originalContent}
      modified={modifiedContent}
      theme={THEME_NAME}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<Note>…</Note>}
      onMount={(editor) => {
        editorRef.current = editor;
        // Cheap insurance mirroring ModifiedContent — see that file's comment.
        editor.onDidDispose(() => {
          editorRef.current = null;
        });
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        fontFamily: fontMono,
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}

/** `modified`/`renamed`: `sha^` (original) vs. `sha` (modified), both read-only. */
function ModifiedAt({
  session,
  sha,
  path,
  basePath,
}: {
  session: string;
  sha: string;
  path: string;
  basePath: string;
}) {
  const original = useFileAt(session, `${sha}^`, basePath);
  const modified = useFileAt(session, sha, path);

  // Tolerated per the brief even though `effectiveStatus` already keeps a
  // root commit out of this branch: an unexpected 404 on the parent blob
  // degrades to an added-only view instead of an error.
  const originalMissing = original.error instanceof ApiError && original.error.status === 404;
  if (originalMissing) return <AddedAt session={session} sha={sha} path={path} />;

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
    <HistoryDiffEditor
      session={session}
      originalRef={`${sha}^`}
      originalPath={basePath}
      originalContent={original.data.content ?? ''}
      modifiedRef={sha}
      modifiedPath={path}
      modifiedContent={modified.data.content ?? ''}
    />
  );
}

/**
 * The Monaco body for one file in a commit's `show` (SPEC §8, Task 9). Kept
 * apart from `HistoryFileSection` so its hooks — and Monaco itself — run only
 * once the section is expanded (mount-on-expand; no IntersectionObserver is
 * needed the way the diff view's `FileDiffSection` needs one, since a commit's
 * file list is short and never mounts by default beyond `defaultFileExpanded`).
 */
export function HistoryFileContent({
  session,
  sha,
  entry,
  isRootCommit,
}: {
  session: string;
  sha: string;
  entry: DiffEntry;
  isRootCommit: boolean;
}) {
  switch (effectiveStatus(entry.status, isRootCommit)) {
    case 'added':
      return <AddedAt session={session} sha={sha} path={entry.path} />;
    case 'deleted':
      return <DeletedContent session={session} against={`${sha}^`} path={entry.path} />;
    case 'modified':
    case 'renamed':
      return (
        <ModifiedAt
          session={session}
          sha={sha}
          path={entry.path}
          basePath={entry.old_path ?? entry.path}
        />
      );
    default:
      return null;
  }
}
