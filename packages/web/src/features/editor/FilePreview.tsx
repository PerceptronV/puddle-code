import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { apiFetchRaw } from '../../lib/api';
import { useClientSettings } from '../../lib/client-settings';
import { rootParam } from '../../lib/worktree-queries';
import { useEditor } from '../workspace/editor-context';
import { bufferKey, subscribe } from './buffer-store';
import { ConflictSurface } from './ConflictSurface';
import { useEditorBuffer } from './use-editor-buffer';
import { markdownToHtml } from './markdown';
import { MATH_LAYOUT_CSS } from './math';
import { renderMathInDocument } from './math-dom';
import { previewKind, resolvePreviewAsset, type PreviewKind } from './preview-kind';

/**
 * The rendered view of a previewable file tab (SPEC §8): markdown as inline,
 * theme-styled prose; HTML in a sandboxed iframe (`allow-scripts` without
 * `allow-same-origin`, so the document can never reach the app's origin,
 * token, or storage). The text comes from the tab's shared Monaco model —
 * created from the fetched file on first use — so the preview tracks unsaved
 * edits live. Markdown is sanitised with DOMPurify before it touches
 * innerHTML. Worktree asset references — relative to the document, or
 * absolute from the worktree root — resolve through the authed media endpoint
 * (element loads carry no bearer header): object URLs for inline markdown,
 * data URIs baked into the HTML iframe (a null-origin document cannot load
 * this origin's blob URLs). LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is
 * typeset by KaTeX in BOTH views — for the iframe, before the document is
 * serialised, since that document is on its own once it is. Ctrl/⌘-click on a
 * worktree link in a markdown preview opens that file as an editor tab,
 * previewable files landing straight in their rendered view.
 */
export function FilePreview({
  session,
  path,
  kind,
  root,
  focused = true,
}: {
  session: string;
  path: string;
  kind: PreviewKind;
  /** Absolute browse root of an `external` tab (SPEC §8): the preview reads
      the same rooted buffer the source editor edits, and its asset/link
      resolution stays inside that root. */
  root?: string;
  focused?: boolean;
}) {
  const buffer = useEditorBuffer(session, path, null, root, {
    passive: true,
    live: true,
    focused,
  });
  const model = buffer.model;
  const text = useSyncExternalStore(
    (onChange) => subscribe(bufferKey(session, path, root), onChange),
    () => model?.getValue() ?? null,
  );
  // A rendered preview cannot host Monaco's reconciliation surface itself.
  // Keep it as-is while the question is merely offered; after Compare, hand the
  // tab to CodeEditor so loading, retry, and the editable diff are guaranteed.
  if (buffer.conflict && buffer.conflict.phase !== 'unresolved') {
    return <ConflictSurface session={session} path={path} buffer={buffer} focused={focused} />;
  }
  if (text === null) return null; // loading, or a binary masquerading by extension
  return kind === 'markdown' ? (
    <MarkdownPreview session={session} path={path} text={text} root={root} />
  ) : (
    <HtmlPreview session={session} path={path} text={text} root={root} />
  );
}

/** External links open a new tab; worktree links navigate via ctrl/⌘-click below. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function MarkdownPreview({
  session,
  path,
  text,
  root,
}: {
  session: string;
  path: string;
  text: string;
  root?: string;
}) {
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(text)), [text]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Resolve worktree images (relative or /-absolute) through the authed media
  // endpoint: an <img src> carries no bearer header, so the bytes travel as a
  // fetch → object URL (the MediaViewer pattern). Re-runs on HTML changes.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    let cancelled = false;
    const urls: string[] = [];
    for (const img of container.querySelectorAll('img')) {
      const resolved = resolvePreviewAsset(path, img.getAttribute('src') ?? '');
      if (!resolved) continue;
      img.removeAttribute('src'); // never let the browser chase the raw relative URL
      apiFetchRaw(
        'GET',
        `/api/worktrees/${session}/media?path=${encodeURIComponent(resolved)}${rootParam(root)}`,
      )
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
  }, [html, session, path, root]);

  // Worktree links navigate on ctrl/⌘-click (the terminal file-link gesture):
  // the target opens as an editor tab, previewable files straight in their
  // rendered view so documentation cross-links read like pages. A plain click
  // on a worktree or same-document link stays inert (http(s) links keep their
  // browser behaviour via target=_blank).
  const { openFile } = useEditor();
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) return;
    e.preventDefault();
    if (!e.metaKey && !e.ctrlKey) return;
    const resolved = resolvePreviewAsset(path, href);
    if (!resolved) return;
    // Inside an external (rooted) preview the link resolves against the SAME
    // root — a `file` tab would resolve it against the worktree and open a
    // different file, or none.
    openFile(session, resolved, undefined, {
      ...(previewKind(resolved) ? { view: 'preview' as const } : {}),
      ...(root !== undefined ? { root } : {}),
    });
  };

  // The preview is the editor's rendered view, so it follows the editor font
  // size (Settings → Appearance); the md-preview scale is em-based, so
  // headings, code, and spacing all track the base.
  const fontSize = useClientSettings().editorFontSize;
  return (
    <div className="h-full overflow-y-auto bg-ground">
      <div
        ref={bodyRef}
        onClick={onClick}
        style={{ fontSize }}
        className="md-preview mx-auto max-w-3xl px-6 py-5 text-fg-secondary"
        // Sanitised above — DOMPurify with the default profile, no raw input.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** (element selector, URL attribute) pairs whose worktree references get inlined. */
const HTML_ASSET_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ['img', 'src'],
  ['script', 'src'],
  ['link[rel~="stylesheet" i]', 'href'],
  ['link[rel~="icon" i]', 'href'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
];

/** Assets above this stay unresolved — data URIs live in memory as the document. */
const MAX_INLINE_ASSET_BYTES = 20 * 1024 * 1024;

function HtmlPreview({
  session,
  path,
  text,
  root,
}: {
  session: string;
  path: string;
  text: string;
  root?: string;
}) {
  const [doc, setDoc] = useState<string | null>(null);
  // Resolved path → data-URI promise, per mount: an edit re-inlines the
  // document without re-fetching every asset.
  const assets = useRef(new Map<string, Promise<string | null>>());
  const fontSize = useClientSettings().editorFontSize;

  useEffect(() => {
    let cancelled = false;
    void inlineWorktreeAssets(session, path, text, assets.current, fontSize, root).then((html) => {
      if (!cancelled) setDoc(html);
    });
    return () => {
      cancelled = true;
    };
  }, [session, path, text, fontSize, root]);

  if (doc === null) return null; // first inline pass; later passes keep the old doc up
  return (
    <iframe
      // allow-scripts WITHOUT allow-same-origin: the document runs on a null
      // origin — it cannot read the app's cookies, storage, or daemon token.
      // That null origin is also why assets are baked in as data URIs: it
      // cannot load this origin's blob URLs, and giving it a tokened URL
      // would hand the daemon token to arbitrary document scripts.
      sandbox="allow-scripts"
      srcDoc={doc}
      title={path}
      className="size-full bg-paper"
    />
  );
}

/**
 * Rewrite the document's worktree asset references (relative or /-absolute;
 * img/script/stylesheet/icon/media) to data URIs fetched through the authed
 * API, and typeset its maths. Nested references — url(…) inside stylesheets,
 * imports inside scripts — are not chased.
 */
async function inlineWorktreeAssets(
  session: string,
  docPath: string,
  text: string,
  cache: Map<string, Promise<string | null>>,
  baseFontSize?: number,
  root?: string,
): Promise<string> {
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  // The preview follows the editor font size, as a ZERO-specificity default
  // (`:where`), prepended so any stylesheet the document carries wins.
  if (baseFontSize !== undefined) {
    const base = parsed.createElement('style');
    base.textContent = `:where(html) { font-size: ${baseFontSize}px; }`;
    const head = parsed.head ?? parsed.documentElement;
    head.insertBefore(base, head.firstChild);
  }
  if (renderMathInDocument(parsed)) await inlineKatexStyles(parsed);
  const jobs: Array<Promise<void>> = [];
  for (const [selector, attr] of HTML_ASSET_ATTRS) {
    for (const el of parsed.querySelectorAll(selector)) {
      const resolved = resolvePreviewAsset(docPath, el.getAttribute(attr) ?? '');
      if (!resolved) continue;
      el.removeAttribute(attr); // never let the iframe chase the raw reference
      jobs.push(
        fetchDataUri(session, resolved, cache, root).then((uri) => {
          if (uri) el.setAttribute(attr, uri);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

/**
 * Give a document that turned out to hold maths the KaTeX stylesheet, fonts
 * baked in (`plugins/katex-css.ts`) — the iframe's null origin cannot fetch
 * them from here. Loaded on demand: a document without maths never pays for
 * the ~400 KB of embedded faces.
 */
async function inlineKatexStyles(doc: Document): Promise<void> {
  const { default: css } = await import('virtual:katex-inline-css');
  const style = doc.createElement('style');
  style.textContent = `${css}\n${MATH_LAYOUT_CSS}`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function fetchDataUri(
  session: string,
  path: string,
  cache: Map<string, Promise<string | null>>,
  root?: string,
): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const job = apiFetchRaw(
    'GET',
    `/api/worktrees/${session}/media?path=${encodeURIComponent(path)}${rootParam(root)}`,
  )
    .then((res) => res.blob())
    .then(async (blob) => {
      if (blob.size > MAX_INLINE_ASSET_BYTES) return null;
      return `data:${inlineMime(path, blob.type)};base64,${base64Of(await blob.arrayBuffer())}`;
    })
    .catch(() => null); // a missing asset just stays blank, like a browser
  cache.set(path, job);
  return job;
}

/**
 * The MIME a data URI must carry for the browser to honour the asset: the
 * media endpoint falls back to octet-stream for types it does not know
 * (css/js), under which a stylesheet or script data URI would be ignored.
 */
function inlineMime(path: string, fromServer: string): string {
  const ext = (path.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'css') return 'text/css';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript';
  return fromServer !== '' && fromServer !== 'application/octet-stream'
    ? fromServer
    : 'application/octet-stream';
}

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
