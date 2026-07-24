import { useEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { apiFetchRaw } from '../../lib/api';
import { useWorktreeFile } from '../../lib/worktree-queries';
import { bufferKey, getOrCreateModel, subscribe } from './buffer-store';
import { markdownToHtml } from './markdown';
import { resolvePreviewAsset, type PreviewKind } from './preview-kind';

/**
 * The rendered view of a previewable file tab (SPEC §8): markdown as inline,
 * theme-styled prose; HTML in a sandboxed iframe (`allow-scripts` without
 * `allow-same-origin`, so the document can never reach the app's origin,
 * token, or storage). The text comes from the tab's shared Monaco model —
 * created from the fetched file on first use — so the preview tracks unsaved
 * edits live. Markdown is sanitised with DOMPurify before it touches
 * innerHTML; relative image references resolve through the authed media
 * endpoint to object URLs (element loads carry no bearer header). The HTML
 * iframe intentionally resolves no relative assets in v1.
 */
export function FilePreview({
  session,
  path,
  kind,
}: {
  session: string;
  path: string;
  kind: PreviewKind;
}) {
  const text = useLiveText(session, path);
  if (text === null) return null; // loading, or a binary masquerading by extension
  return kind === 'markdown' ? (
    <MarkdownPreview session={session} path={path} text={text} />
  ) : (
    <HtmlPreview path={path} text={text} />
  );
}

/**
 * The tab's live text: the shared (session, path) model the source editor
 * uses, created from the fetched file when the preview mounts first. The
 * model is retained by the tree-wide ModelRefcount for every open editor tab,
 * so no retain/release is needed here.
 */
function useLiveText(session: string, path: string): string | null {
  const file = useWorktreeFile(session, path);
  const content = file.data && !file.data.binary ? file.data.content : null;
  const model =
    content !== null && file.data
      ? getOrCreateModel(session, path, content, file.data.mtime_ms)
      : null;
  return useSyncExternalStore(
    (onChange) => subscribe(bufferKey(session, path), onChange),
    () => model?.getValue() ?? null,
  );
}

/** External links open a new tab; relative/anchor links have nowhere to go. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function MarkdownPreview({ session, path, text }: { session: string; path: string; text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(text)), [text]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Resolve relative images through the authed media endpoint: an <img src>
  // carries no bearer header, so the bytes travel as a fetch → object URL
  // (the MediaViewer pattern). Re-runs whenever the rendered HTML changes.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    let cancelled = false;
    const urls: string[] = [];
    for (const img of root.querySelectorAll('img')) {
      const resolved = resolvePreviewAsset(path, img.getAttribute('src') ?? '');
      if (!resolved) continue;
      img.removeAttribute('src'); // never let the browser chase the raw relative URL
      apiFetchRaw('GET', `/api/worktrees/${session}/media?path=${encodeURIComponent(resolved)}`)
        .then((res) => res.blob())
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
        })
        .catch(() => undefined); // a missing asset just stays blank, like a browser
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, session, path]);

  // Relative and same-document links have no navigation target inside the app.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor && !/^https?:/i.test(anchor.getAttribute('href') ?? '')) e.preventDefault();
  };

  return (
    <div className="h-full overflow-y-auto bg-ground">
      <div
        ref={bodyRef}
        onClick={onClick}
        className="md-preview mx-auto max-w-3xl px-6 py-5 text-sm text-fg-secondary"
        // Sanitised above — DOMPurify with the default profile, no raw input.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function HtmlPreview({ path, text }: { path: string; text: string }) {
  return (
    <iframe
      // allow-scripts WITHOUT allow-same-origin: the document runs on a null
      // origin — it cannot read the app's cookies, storage, or daemon token.
      sandbox="allow-scripts"
      srcDoc={text}
      title={path}
      className="size-full bg-paper"
    />
  );
}
