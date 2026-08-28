import { latexSynctexResponseSchema, type LatexSynctexResponse } from '@puddle/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { toast } from 'sonner';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import { api } from '../../lib/api';
import {
  adjacentPdfZoom,
  PDF_ZOOM_LEVELS,
  pdfPagePoint,
  pdfRenderOutputScale,
} from './pdf-coordinates';

interface PdfViewerProps {
  url: string;
  session: string;
  path: string;
  root: string;
  onRevealSource?: (target: LatexSynctexResponse) => void;
  onDownload: () => void;
}

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/**
 * Owned PDF.js view for daemon-generated LaTeX output. The library and its
 * worker are fetched only after this component mounts; ordinary PDF tabs keep
 * using the browser viewer and never pay this cost.
 */
export function PdfViewer({
  url,
  session,
  path,
  root,
  onRevealSource,
  onDownload,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomFrameRef = useRef(0);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const width = useAvailablePageWidth(scrollRef);
  const minimumZoom = PDF_ZOOM_LEVELS[0];
  const maximumZoom = PDF_ZOOM_LEVELS.at(-1)!;

  const changeZoom = useCallback(
    (nextZoom: number) => {
      if (nextZoom === zoom) return;
      const scroller = scrollRef.current;
      const horizontalAnchor = scroller
        ? (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth
        : 0.5;
      const verticalAnchor = scroller
        ? (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight
        : 0;
      setZoom(nextZoom);
      cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = requestAnimationFrame(() => {
        if (!scroller) return;
        scroller.scrollLeft = horizontalAnchor * scroller.scrollWidth - scroller.clientWidth / 2;
        scroller.scrollTop = verticalAnchor * scroller.scrollHeight - scroller.clientHeight / 2;
      });
    },
    [zoom],
  );

  useEffect(() => () => cancelAnimationFrame(zoomFrameRef.current), []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedDocument: PDFDocumentProxy | null = null;
    setDocument(null);
    setError(false);

    void loadPdfJs()
      .then((pdfjs) => {
        if (cancelled) return null;
        loadingTask = pdfjs.getDocument({ url });
        return loadingTask.promise;
      })
      .then((pdf) => {
        if (!pdf) return;
        loadedDocument = pdf;
        if (cancelled) {
          void loadingTask?.destroy();
          return;
        }
        setDocument(pdf);
      })
      .catch((cause: unknown) => {
        if (!cancelled && !isPdfCancellation(cause)) setError(true);
      });

    return () => {
      cancelled = true;
      setDocument(null);
      if (loadedDocument) void loadedDocument.cleanup();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [url]);

  const reveal = useCallback(
    async (page: number, x: number, y: number) => {
      if (!onRevealSource) return;
      try {
        const response = await api<unknown>('POST', '/api/latex/synctex', {
          session,
          path,
          root,
          page,
          x,
          y,
        });
        onRevealSource(latexSynctexResponseSchema.parse(response));
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : 'Couldn’t locate the TeX source');
      }
    },
    [onRevealSource, path, root, session],
  );

  if (error) {
    return (
      <Status>
        <p className="text-sm text-fg-secondary">Couldn’t display this PDF.</p>
        <button
          type="button"
          onClick={onDownload}
          className="rounded-md bg-elevated px-3 py-1.5 text-sm text-fg transition-colors hover:bg-border/70"
        >
          Download
        </button>
      </Status>
    );
  }

  return (
    <div className="relative h-full w-full bg-ground">
      <div ref={scrollRef} className="h-full w-full overflow-auto">
        {!document || width === null ? (
          <Status>
            <span className="text-xs text-fg-muted">Loading PDF…</span>
          </Status>
        ) : (
          <div className="flex min-h-full w-max min-w-full flex-col items-center gap-4 p-4">
            {Array.from({ length: document.numPages }, (_, index) => (
              <PdfPage
                key={index + 1}
                document={document}
                pageNumber={index + 1}
                availableWidth={width * zoom}
                scrollRoot={scrollRef.current}
                inverseSearch={onRevealSource ? reveal : undefined}
              />
            ))}
          </div>
        )}
      </div>
      {document && width !== null && (
        <PdfZoomControls
          zoom={zoom}
          minimum={minimumZoom}
          maximum={maximumZoom}
          onZoomOut={() => changeZoom(adjacentPdfZoom(zoom, 'out'))}
          onReset={() => changeZoom(1)}
          onZoomIn={() => changeZoom(adjacentPdfZoom(zoom, 'in'))}
        />
      )}
    </div>
  );
}

function PdfZoomControls({
  zoom,
  minimum,
  maximum,
  onZoomOut,
  onReset,
  onZoomIn,
}: {
  zoom: number;
  minimum: number;
  maximum: number;
  onZoomOut: () => void;
  onReset: () => void;
  onZoomIn: () => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-md bg-surface/90 p-1 shadow-sm backdrop-blur-sm">
      <button
        type="button"
        disabled={zoom <= minimum}
        onClick={onZoomOut}
        className="cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40"
        aria-label="Zoom out"
        title="Zoom out"
      >
        <ZoomOut className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onReset}
        className="min-w-12 cursor-pointer rounded-sm px-1.5 py-1 font-mono text-[11px] tabular-nums text-fg-secondary transition-colors hover:bg-elevated hover:text-fg"
        aria-label={`Zoom ${Math.round(zoom * 100)}%; reset to fit width`}
        title="Reset to fit width"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        disabled={zoom >= maximum}
        onClick={onZoomIn}
        className="cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40"
        aria-label="Zoom in"
        title="Zoom in"
      >
        <ZoomIn className="size-3.5" />
      </button>
    </div>
  );
}

function PdfPage({
  document,
  pageNumber,
  availableWidth,
  scrollRoot,
  inverseSearch,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  availableWidth: number;
  scrollRoot: HTMLElement | null;
  inverseSearch?: (page: number, x: number, y: number) => Promise<void>;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderRef = useRef<RenderTask | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState(false);
  const renderReady = useRenderWhenNear(holderRef, scrollRoot, pageNumber <= 2);

  useEffect(() => {
    let cancelled = false;
    let loadedPage: PDFPageProxy | null = null;
    setPage(null);
    setPageSize(null);
    setError(false);
    void document
      .getPage(pageNumber)
      .then((resolvedPage) => {
        loadedPage = resolvedPage;
        if (cancelled) {
          resolvedPage.cleanup();
          return;
        }
        const viewport = resolvedPage.getViewport({ scale: 1 });
        setPageSize({ width: viewport.width, height: viewport.height });
        setPage(resolvedPage);
      })
      .catch((cause: unknown) => {
        if (!cancelled && !isPdfCancellation(cause)) setError(true);
      });
    return () => {
      cancelled = true;
      renderRef.current?.cancel();
      renderRef.current = null;
      loadedPage?.cleanup();
    };
  }, [document, pageNumber]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page || !pageSize || !renderReady) return;
    const scale = availableWidth / pageSize.width;
    const cssViewport = page.getViewport({ scale });
    const outputScale = pdfRenderOutputScale(
      cssViewport.width,
      cssViewport.height,
      window.devicePixelRatio || 1,
    );
    const renderViewport = page.getViewport({ scale: scale * outputScale });

    renderRef.current?.cancel();
    canvas.width = Math.max(1, Math.floor(renderViewport.width));
    canvas.height = Math.max(1, Math.floor(renderViewport.height));
    canvas.style.width = `${cssViewport.width}px`;
    canvas.style.height = `${cssViewport.height}px`;
    const task = page.render({ canvas, viewport: renderViewport });
    renderRef.current = task;
    void task.promise
      .catch((cause: unknown) => {
        if (!isPdfCancellation(cause)) setError(true);
      })
      .finally(() => {
        if (renderRef.current === task) renderRef.current = null;
      });

    return () => {
      task.cancel();
      if (renderRef.current === task) renderRef.current = null;
    };
  }, [availableWidth, page, pageSize, renderReady]);

  const onClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if ((!event.metaKey && !event.ctrlKey) || !inverseSearch || !pageSize) return;
    const point = pdfPagePoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      pageSize.width,
      pageSize.height,
    );
    if (!point) return;
    event.preventDefault();
    void inverseSearch(pageNumber, point.x, point.y);
  };

  if (error) {
    return <p className="py-8 text-xs text-fg-muted">Couldn’t render page {pageNumber}.</p>;
  }

  const fittedHeight = pageSize
    ? Math.round((availableWidth / pageSize.width) * pageSize.height)
    : Math.round(availableWidth * 1.3);
  return (
    <div
      ref={holderRef}
      className="shrink-0 bg-elevated shadow-sm"
      style={{ width: availableWidth, height: fittedHeight }}
      aria-label={`PDF page ${pageNumber}`}
    >
      <canvas
        ref={canvasRef}
        onClick={onClick}
        className="block"
        title={inverseSearch ? 'Command-click to open the corresponding TeX source' : undefined}
      />
    </div>
  );
}

/** Paint a page once it nears the scrollport, then retain its canvas. */
function useRenderWhenNear(
  ref: React.RefObject<HTMLElement | null>,
  scrollRoot: HTMLElement | null,
  initiallyReady: boolean,
): boolean {
  const [ready, setReady] = useState(initiallyReady);
  useEffect(() => {
    if (ready) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setReady(true);
        observer.disconnect();
      },
      { root: scrollRoot, rootMargin: '100% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, ref, scrollRoot]);
  return ready;
}

function useAvailablePageWidth(ref: React.RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(Math.max(1, element.clientWidth - 32)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

function Status({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-3 p-4">
      {children}
    </div>
  );
}

function isPdfCancellation(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === 'RenderingCancelledException' || cause.name === 'AbortException')
  );
}

async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })
    .catch((cause: unknown) => {
      // A transient chunk failure should be retryable when the tab remounts.
      pdfJsPromise = null;
      throw cause;
    });
  return pdfJsPromise;
}
