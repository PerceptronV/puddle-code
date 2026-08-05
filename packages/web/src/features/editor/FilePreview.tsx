import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { apiFetchRaw } from '../../lib/api';
import { useClientSettings } from '../../lib/client-settings';
import { useEditor } from '../workspace/editor-context';
import { bufferKey, subscribe } from './buffer-store';
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
    <HtmlPreview session={session} path={path} text={text} />
  );
}

/**
 * The tab's live text — live in BOTH directions (SPEC §8):
 *
 * - **the buffer**, when one is open: the very model the source editor edits, so
 *   a preview beside an editor re-renders on every keystroke and ⌘S in either
 *   view saves the one buffer (the preview registers its save, since it has no
 *   Monaco to own the chord — `save-registry.ts`);
 * - **the file**, otherwise: `live` polls it and the hook's clean-refocus rule
 *   adopts anything newer, so a preview of a document an AGENT is writing keeps
 *   up. Before this the model was created once from the first read and the
 *   rendered view then never moved again.
 *
 * `passive` is what makes it safe to hold the buffer beside a real editor: a
 * reading view writes no drafts and announces nothing. The model is retained by
 * the tree-wide ModelRefcount for every open editor tab, so no retain/release
 * is needed here.
 */
function useLiveText(session: string, path: string): string | null {
  const buffer = useEditorBuffer(session, path, null, undefined, { passive: true, live: true });
  const model = buffer.model;
  return useSyncExternalStore(
    (onChange) => subscribe(bufferKey(session, path), onChange),
    () => model?.getValue() ?? null,
  );
}

/** External links open a new tab; worktree links navigate via ctrl/⌘-click below. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function MarkdownPreview({ session, path, text }: { session: string; path: string; text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(text)), [text]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Resolve worktree images (relative or /-absolute) through the authed media
  // endpoint: an <img src> carries no bearer header, so the bytes travel as a
  // fetch → object URL (the MediaViewer pattern). Re-runs on HTML changes.
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
    openFile(session, resolved, undefined, previewKind(resolved) ? { view: 'preview' } : undefined);
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

function HtmlPreview({ session, path, text }: { session: string; path: string; text: string }) {
  const [doc, setDoc] = useState<string | null>(null);
  // Resolved path → data-URI promise, per mount: an edit re-inlines the
  // document without re-fetching every asset.
  const assets = useRef(new Map<string, Promise<string | null>>());
  const fontSize = useClientSettings().editorFontSize;

  useEffect(() => {
    let cancelled = false;
    void inlineWorktreeAssets(session, path, text, assets.current, fontSize).then((html) => {
      if (!cancelled) setDoc(html);
    });
    return () => {
      cancelled = true;
    };
  }, [session, path, text, fontSize]);

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
        fetchDataUri(session, resolved, cache).then((uri) => {
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
): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const job = apiFetchRaw('GET', `/api/worktrees/${session}/media?path=${encodeURIComponent(path)}`)
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
