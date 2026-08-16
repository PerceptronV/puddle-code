import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { apiFetchRaw } from '../../lib/api';
import { useClientSettings } from '../../lib/client-settings';
import { rootParam } from '../../lib/worktree-queries';
import { DomFindController } from '../find/dom-find';
import { FindWidget } from '../find/FindWidget';
import { EMPTY_FIND_RESULT } from '../find/find-types';
import { useFindControls, type FindControls } from '../find/use-find-controls';
import { useEditor } from '../workspace/editor-context';
import { bufferKey, subscribe } from './buffer-store';
import { ConflictSurface } from './ConflictSurface';
import { useEditorBuffer } from './use-editor-buffer';
import { markdownToHtml } from './markdown';
import { MATH_LAYOUT_CSS } from './math';
import { renderMathInDocument } from './math-dom';
import { previewKind, resolvePreviewAsset, type PreviewKind } from './preview-kind';
import {
  appendHtmlPreviewScrollBridge,
  applyHtmlPreviewScroll,
  createHtmlPreviewScrollChannel,
  htmlPreviewScrollReport,
} from './html-preview-scroll';
import {
  appendHtmlPreviewFindBridge,
  applyHtmlPreviewFind,
  clearHtmlPreviewFind,
  htmlPreviewFindMessage,
  HTML_PREVIEW_FIND_OPEN,
  HTML_PREVIEW_FIND_RESULT,
} from './html-preview-find';
import {
  bindPreviewScrollElement,
  previewScrollStore,
  type PreviewScrollTarget,
} from './preview-scroll-store';

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
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
}: {
  session: string;
  path: string;
  kind: PreviewKind;
  /** Absolute browse root of an `external` tab (SPEC §8): the preview reads
      the same rooted buffer the source editor edits, and its asset/link
      resolution stays inside that root. */
  root?: string;
  focused?: boolean;
  scrollDriver?: boolean;
  scrollReceiver?: boolean;
  scrollChannel?: string;
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
    <MarkdownPreview
      session={session}
      path={path}
      text={text}
      root={root}
      scrollDriver={scrollDriver}
      scrollReceiver={scrollReceiver}
      scrollChannel={scrollChannel}
      focused={focused}
    />
  ) : (
    <HtmlPreview
      session={session}
      path={path}
      text={text}
      root={root}
      scrollDriver={scrollDriver}
      scrollReceiver={scrollReceiver}
      scrollChannel={scrollChannel}
      focused={focused}
    />
  );
}

function FindOverlay({ controls }: { controls: FindControls }) {
  if (!controls.open) return null;
  return (
    <FindWidget
      query={controls.query}
      focusKey={controls.focusKey}
      options={controls.options}
      result={controls.result}
      onQueryChange={controls.setQuery}
      onOptionsChange={controls.setOptions}
      onNext={controls.next}
      onPrevious={controls.previous}
      onClose={controls.close}
    />
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
  scrollDriver,
  scrollReceiver,
  scrollChannel,
  focused,
}: {
  session: string;
  path: string;
  text: string;
  root?: string;
  scrollDriver: boolean;
  scrollReceiver: boolean;
  scrollChannel: string;
  focused: boolean;
}) {
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(text)), [text]);
  // React compares dangerouslySetInnerHTML by object identity before writing
  // innerHTML. Keep that object stable across find-result state updates: a
  // redundant rewrite replaces every text node, detaching the CSS Highlight
  // ranges immediately after they are painted and leaving navigation with
  // detached elements that cannot scroll into view.
  const renderedHtml = useMemo(() => ({ __html: html }), [html]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const findControllerRef = useRef<DomFindController | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const controller = new DomFindController(body);
    findControllerRef.current = controller;
    return () => {
      controller.dispose();
      findControllerRef.current = null;
    };
  }, []);

  const find = useFindControls({
    shortcutEnabled: focused,
    onFind: (query, options, direction) =>
      findControllerRef.current?.find(query, options, direction) ?? EMPTY_FIND_RESULT,
    onClear: () => findControllerRef.current?.clear(),
    onCloseFocus: () => scrollerRef.current?.focus({ preventScroll: true }),
  });

  // React replaces the rendered prose when the shared buffer changes. Rebuild
  // the ranges against the new text instead of retaining detached Range nodes.
  useEffect(() => find.refresh(), [html, find.refresh]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    return bindPreviewScrollElement(scroller, {
      channel: scrollChannel,
      target: { session, path, root },
      driver: scrollDriver,
      receiver: scrollReceiver,
      resizeElements: [scroller, body],
    });
  }, [html, session, path, root, scrollChannel, scrollDriver, scrollReceiver]);

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
    <div className="relative size-full bg-ground">
      <div ref={scrollerRef} tabIndex={-1} className="h-full overflow-y-auto outline-none">
        <div
          ref={bodyRef}
          onClick={onClick}
          style={{ fontSize }}
          className="md-preview mx-auto max-w-3xl px-6 py-5 text-fg-secondary"
          // Sanitised above — DOMPurify with the default profile, no raw input.
          dangerouslySetInnerHTML={renderedHtml}
        />
      </div>
      <FindOverlay controls={find} />
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
  scrollDriver,
  scrollReceiver,
  scrollChannel,
  focused,
}: {
  session: string;
  path: string;
  text: string;
  root?: string;
  scrollDriver: boolean;
  scrollReceiver: boolean;
  scrollChannel: string;
  focused: boolean;
}) {
  const [doc, setDoc] = useState<string | null>(null);
  // Resolved path → data-URI promise, per mount: an edit re-inlines the
  // document without re-fetching every asset.
  const assets = useRef(new Map<string, Promise<string | null>>());
  const fontSize = useClientSettings().editorFontSize;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bridgeChannel] = useState(createHtmlPreviewScrollChannel);
  const [findChannel] = useState(createHtmlPreviewScrollChannel);
  const find = useFindControls({
    shortcutEnabled: focused,
    onFind: (query, options, direction) =>
      applyHtmlPreviewFind(
        iframeRef.current?.contentWindow ?? null,
        findChannel,
        query,
        options,
        direction,
      ),
    onClear: () => clearHtmlPreviewFind(iframeRef.current?.contentWindow ?? null, findChannel),
    onCloseFocus: () => iframeRef.current?.focus(),
  });
  const target = useMemo<PreviewScrollTarget>(
    () => ({ session, path, root }),
    [session, path, root],
  );

  useEffect(() => {
    let cancelled = false;
    void inlineWorktreeAssets(
      session,
      path,
      text,
      assets.current,
      fontSize,
      root,
      bridgeChannel,
      findChannel,
    ).then((html) => {
      if (!cancelled) setDoc(html);
    });
    return () => {
      cancelled = true;
    };
  }, [session, path, text, fontSize, root, bridgeChannel, findChannel]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = htmlPreviewFindMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        findChannel,
      );
      if (message?.kind === HTML_PREVIEW_FIND_OPEN) find.openFind();
      else if (message?.kind === HTML_PREVIEW_FIND_RESULT) find.setResult(message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [find.openFind, find.setResult, findChannel]);

  useEffect(() => {
    if (!scrollReceiver) return;
    return previewScrollStore.subscribe(scrollChannel, target, (position) => {
      applyHtmlPreviewScroll(
        iframeRef.current?.contentWindow ?? null,
        bridgeChannel,
        position.ratio,
      );
    });
  }, [scrollReceiver, scrollChannel, target, bridgeChannel]);

  useEffect(() => {
    if (!scrollDriver && !scrollReceiver) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const report = htmlPreviewScrollReport(
        event,
        iframeRef.current?.contentWindow ?? null,
        bridgeChannel,
      );
      if (!report) return;
      if (scrollDriver) {
        previewScrollStore.publish(scrollChannel, target, report.ratio);
      } else if (report.layout) {
        const current = previewScrollStore.get(scrollChannel, target);
        if (current) {
          applyHtmlPreviewScroll(
            iframeRef.current?.contentWindow ?? null,
            bridgeChannel,
            current.ratio,
          );
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [scrollDriver, scrollReceiver, scrollChannel, target, bridgeChannel]);

  if (doc === null) return null; // first inline pass; later passes keep the old doc up
  return (
    <div className="relative size-full bg-paper">
      <iframe
        ref={iframeRef}
        // allow-scripts WITHOUT allow-same-origin: the document runs on a null
        // origin — it cannot read the app's cookies, storage, or daemon token.
        // That null origin is also why assets are baked in as data URIs: it
        // cannot load this origin's blob URLs, and giving it a tokened URL
        // would hand the daemon token to arbitrary document scripts.
        sandbox="allow-scripts"
        srcDoc={doc}
        title={path}
        className="size-full bg-paper"
        onLoad={() => {
          if (scrollReceiver) {
            const current = previewScrollStore.get(scrollChannel, target);
            if (current) {
              applyHtmlPreviewScroll(
                iframeRef.current?.contentWindow ?? null,
                bridgeChannel,
                current.ratio,
              );
            }
          }
          find.refresh();
        }}
      />
      <FindOverlay controls={find} />
    </div>
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
  bridgeChannel?: string,
  findChannel?: string,
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
  if (bridgeChannel) appendHtmlPreviewScrollBridge(parsed, bridgeChannel);
  if (findChannel) appendHtmlPreviewFindBridge(parsed, findChannel);
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
