import { useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetchRaw } from '../../lib/api';
import { rootParam, useWorktreeFile } from '../../lib/worktree-queries';
import { THEME_NAME } from './monaco-setup';
import { mediaKind } from './media-kind';
import { MediaViewer } from './MediaViewer';

/** Download for a rooted file — `downloadPath` is worktree-only by design. */
async function downloadExternal(session: string, path: string, root: string): Promise<void> {
  const res = await apiFetchRaw(
    'GET',
    `/api/worktrees/${session}/download?path=${encodeURIComponent(path)}${rootParam(root)}`,
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').filter(Boolean).pop() ?? 'file';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The body of an `external` tab (SPEC §8): a file the explorer's parent
 * navigation opened from OUTSIDE the worktree, shown read-only. Deliberately
 * bypasses the shared buffer store, drafts, and peer sync — those are keyed
 * to worktree files and carry save flows an external file must never have
 * (the daemon rejects rooted writes). Media renders through the same viewer
 * as worktree files, with the browse root threaded into the fetch.
 */
export function ExternalFileBody({
  session,
  path,
  root,
}: {
  session: string;
  path: string;
  root: string;
}) {
  const media = mediaKind(path);
  const file = useWorktreeFile(session, path, { root, enabled: media === null });
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  if (media) return <MediaViewer session={session} path={path} kind={media} root={root} />;

  const message =
    file.error instanceof ApiError && file.error.status === 413
      ? 'File too large to view — use Download'
      : file.error
        ? file.error instanceof Error
          ? file.error.message
          : 'Failed to load file'
        : file.data?.binary
          ? 'Binary file — use Download'
          : null;
  if (message !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ground text-sm text-fg-muted">
        <span>{message}</span>
        <button
          type="button"
          onClick={() =>
            void downloadExternal(session, path, root).catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : 'Download failed'),
            )
          }
          className="flex items-center gap-1.5 text-fg-secondary transition-colors hover:text-fg"
        >
          <Download className="size-4" />
          Download
        </button>
      </div>
    );
  }
  if (file.data?.content === undefined || file.data.content === null) {
    return <div className="p-3 text-xs text-fg-muted">…</div>;
  }

  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="bg-surface px-3 py-1 text-xs text-fg-muted">
        Outside the worktree — read-only
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          // Not the shared puddle:// model space: keyed per (root, path) so
          // an identical relative path in the worktree stays a separate model.
          path={`puddle-external://${session}/${encodeURIComponent(root)}/${path}`}
          value={file.data.content}
          theme={THEME_NAME}
          loading={<div className="p-3 text-xs text-fg-muted">…</div>}
          options={{
            automaticLayout: true,
            fontFamily: fontMono,
            readOnly: true,
            minimap: { enabled: false },
            fixedOverflowWidgets: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
