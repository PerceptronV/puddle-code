import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import DOMPurify from 'dompurify';
import { useClientSettings } from '../../lib/client-settings';
import { currentTheme, onThemeChange } from '../../lib/theme';
import { DomFindController } from '../find/dom-find';
import { EMPTY_FIND_RESULT } from '../find/find-types';
import { useFindControls } from '../find/use-find-controls';
import { markdownToHtml } from './markdown';
import { renderMermaidDiagrams } from './markdown-mermaid';
import { parsePreviewSrcset, resolvePreviewAsset, serialisePreviewSrcset } from './preview-kind';
import { bindPreviewScrollElement } from './preview-scroll-store';
import { useViewStateKey } from './view-state-context';
import { countSourceLines, measureSourceAnchors, sourceLineAtOffset } from './source-anchor-map';
import { fetchPreviewAsset } from './preview-assets';
import { FindOverlay, editorLine, type TextPreviewProps } from './preview-controls';

/** External links open a new tab; worktree links navigate via ctrl/⌘-click below. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function MarkdownPreview({
  session,
  path,
  text,
  root,
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
  focused = true,
  onRevealSource,
  onOpenFile,
  mobile = false,
}: TextPreviewProps) {
  const viewKey = useViewStateKey('markdown', [session, root, path]);
  const documentId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const theme = useSyncExternalStore(
    (onChange) => onThemeChange(onChange),
    currentTheme,
    currentTheme,
  );
  const html = useMemo(
    () => DOMPurify.sanitize(markdownToHtml(text, documentId)),
    [text, documentId],
  );
  const lineCount = useMemo(() => countSourceLines(text), [text]);
  // React compares dangerouslySetInnerHTML by object identity before writing
  // innerHTML. Keep that object stable across find-result state updates: a
  // redundant rewrite replaces every text node, detaching the CSS Highlight
  // ranges immediately after they are painted and leaving navigation with
  // detached elements that cannot scroll into view.
  const renderedHtml = useMemo(() => ({ __html: html }), [html, theme]);
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
  useEffect(() => find.refresh(), [html, theme, find.refresh]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const abort = new AbortController();
    void renderMermaidDiagrams(body, theme, abort.signal).then(() => {
      // Mermaid replaces source text with SVG labels after the ordinary HTML
      // render, so active rendered-view searches need fresh DOM ranges.
      if (!abort.signal.aborted) find.refresh();
    });
    return () => abort.abort();
  }, [html, theme, find.refresh]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    return bindPreviewScrollElement(scroller, {
      viewKey,
      channel: scrollChannel,
      target: { session, path, root },
      driver: scrollDriver,
      receiver: scrollReceiver,
      resizeElements: [scroller, body],
      sourceAnchors: () => measureSourceAnchors(scroller, body, lineCount),
    });
  }, [html, lineCount, session, path, root, scrollChannel, scrollDriver, scrollReceiver, viewKey]);

  // Resolve worktree images (relative or /-absolute) through the authed media
  // endpoint: image elements carry no bearer header, so the bytes travel as a
  // fetch → object URL (the MediaViewer pattern). Both `src` and `srcset` are
  // covered: a README's theme-aware <picture><source srcset=…> must not bypass
  // the rewrite and ask the browser for a raw cockpit-relative URL.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    let cancelled = false;
    const urls: string[] = [];

    const objectUrlFor = async (resolved: string): Promise<string | null> => {
      try {
        const blob = await fetchPreviewAsset(session, resolved, root);
        if (cancelled) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return url;
      } catch {
        return null; // a missing asset just stays blank, like a browser
      }
    };

    for (const element of container.querySelectorAll('img[src], source[src]')) {
      const resolved = resolvePreviewAsset(path, element.getAttribute('src') ?? '');
      if (!resolved) continue;
      element.removeAttribute('src'); // never let the browser chase the raw relative URL
      void objectUrlFor(resolved).then((url) => {
        if (!cancelled && url) element.setAttribute('src', url);
      });
    }

    for (const element of container.querySelectorAll('img[srcset], source[srcset]')) {
      const candidates = parsePreviewSrcset(element.getAttribute('srcset') ?? '');
      const paths = candidates.map(({ ref }) => resolvePreviewAsset(path, ref));
      if (!paths.some((resolved) => resolved !== null)) continue;
      element.removeAttribute('srcset'); // stop eager raw-URL requests while assets load
      void Promise.all(
        candidates.map(async (candidate, index) => {
          const resolved = paths[index];
          if (!resolved) return candidate; // browser-owned external/data URL
          const ref = await objectUrlFor(resolved);
          return ref ? { ...candidate, ref } : null;
        }),
      ).then((rewritten) => {
        if (cancelled) return;
        const available = rewritten.filter((candidate) => candidate !== null);
        if (available.length > 0) {
          element.setAttribute('srcset', serialisePreviewSrcset(available));
        }
      });
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, session, path, root]);

  // Desktop uses ctrl/⌘-click; mobile uses a tap to follow worktree links.
  // Fragments scroll in place and http(s) links retain target=_blank.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (/^https?:/i.test(href)) return;
      e.preventDefault();
      if (href.startsWith('#')) {
        const id = decodeFragment(href);
        const target = id
          ? bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
          : null;
        target?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (!mobile && !e.metaKey && !e.ctrlKey) return;
      const resolved = resolvePreviewAsset(path, href);
      if (!resolved) return;
      // Inside an external (rooted) preview the link resolves against the SAME
      // root — a `file` tab would resolve it against the worktree and open a
      // different file, or none.
      onOpenFile?.(resolved);
      return;
    }
    if ((!e.metaKey && !e.ctrlKey) || !onRevealSource) return;
    const scroller = scrollerRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const offset = e.clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const sourceLine = sourceLineAtOffset(measureSourceAnchors(scroller, body, lineCount), offset);
    if (sourceLine === null) return;
    e.preventDefault();
    onRevealSource({ line: editorLine(sourceLine, lineCount) });
  };

  // The preview is the editor's rendered view, so it follows the editor font
  // size (Settings → Appearance); the md-preview scale is em-based, so
  // headings, code, and spacing all track the base.
  const fontSize = useClientSettings().editorFontSize;
  return (
    <div className="relative size-full bg-ground">
      <div
        ref={scrollerRef}
        tabIndex={-1}
        className="h-full overflow-auto overscroll-contain outline-none"
      >
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

function decodeFragment(href: string): string | null {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}
