import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiFetchRaw } from '../../lib/api';
import { downloadPath } from '../../lib/worktree-queries';
import type { MediaKind } from './media-kind';

/**
 * Inline preview for media editor tabs (SPEC §8): image / video / audio / PDF.
 * Fetches the file through the authed API (`GET /media`, the real content-type)
 * and hands the element an **object URL** — so no bearer token ever needs to
 * ride in an element `src` — revoking it on unmount or path change. Falls back
 * to a Download affordance on error.
 */
export function MediaViewer({
  session,
  path,
  kind,
}: {
  session: string;
  path: string;
  kind: MediaKind;
}) {
  const { url, error } = useMediaObjectUrl(session, path);

  if (error) {
    return (
      <Centre>
        <p className="text-sm text-fg-secondary">Couldn’t load this file.</p>
        <DownloadButton session={session} path={path} />
      </Centre>
    );
  }
  if (!url) {
    return (
      <Centre>
        <span className="text-xs text-fg-muted">…</span>
      </Centre>
    );
  }

  if (kind === 'image') {
    return (
      <Centre>
        <img src={url} alt={path} className="max-h-full max-w-full object-contain" />
      </Centre>
    );
  }
  if (kind === 'video') {
    return (
      <Centre>
        <video src={url} controls className="max-h-full max-w-full" />
      </Centre>
    );
  }
  if (kind === 'audio') {
    return (
      <Centre>
        <audio src={url} controls className="w-full max-w-xl" />
      </Centre>
    );
  }
  // pdf
  return <iframe src={url} title={path} className="h-full w-full border-0 bg-ground" />;
}

/** Centres its content over the tab's full height on the editor ground. */
function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-ground p-4">
      {children}
    </div>
  );
}

function DownloadButton({ session, path }: { session: string; path: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        void downloadPath(session, path).catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : 'Download failed'),
        )
      }
      className="rounded-md bg-elevated px-3 py-1.5 text-sm text-fg transition-colors hover:bg-border/70"
    >
      Download
    </button>
  );
}

/** Fetches `path` as an object URL, revoking it on change/unmount. */
function useMediaObjectUrl(session: string, path: string): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(false);
    apiFetchRaw('GET', `/api/worktrees/${session}/media?path=${encodeURIComponent(path)}`)
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session, path]);

  return { url, error };
}
