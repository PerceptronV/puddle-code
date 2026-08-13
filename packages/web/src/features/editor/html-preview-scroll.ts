import { clampScrollRatio } from './preview-scroll-store';

export const HTML_PREVIEW_SCROLL_REPORT = 'puddle-preview-scroll-report';
export const HTML_PREVIEW_SCROLL_APPLY = 'puddle-preview-scroll-apply';

export interface HtmlPreviewScrollReport {
  kind: typeof HTML_PREVIEW_SCROLL_REPORT;
  channel: string;
  ratio: number;
  /** Load/resize report: a locked parent should reapply after document reflow. */
  layout: boolean;
}

/** A fresh, unguessable channel for one mounted sandboxed preview. */
export function createHtmlPreviewScrollChannel(): string {
  return crypto.randomUUID();
}

/**
 * Validate a null-origin iframe message by capability: exact content window,
 * local channel, known kind, and finite payload. `event.origin` is
 * intentionally irrelevant because a sandbox without allow-same-origin has
 * the opaque `null` origin (SPEC §8).
 */
export function htmlPreviewScrollReport(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  iframeWindow: MessageEventSource | null,
  channel: string,
): HtmlPreviewScrollReport | null {
  if (event.source !== iframeWindow || iframeWindow === null) return null;
  if (typeof event.data !== 'object' || event.data === null) return null;
  const data = event.data as Record<string, unknown>;
  if (
    data['kind'] !== HTML_PREVIEW_SCROLL_REPORT ||
    data['channel'] !== channel ||
    typeof data['ratio'] !== 'number' ||
    !Number.isFinite(data['ratio']) ||
    typeof data['layout'] !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: HTML_PREVIEW_SCROLL_REPORT,
    channel,
    ratio: clampScrollRatio(data['ratio']),
    layout: data['layout'],
  };
}

/** Apply one proportional position to the current sandbox document. */
export function applyHtmlPreviewScroll(
  iframeWindow: Pick<Window, 'postMessage'> | null,
  channel: string,
  ratio: number,
): void {
  iframeWindow?.postMessage(
    { kind: HTML_PREVIEW_SCROLL_APPLY, channel, ratio: clampScrollRatio(ratio) },
    '*',
  );
}

/**
 * The only bridge injected into arbitrary HTML. It carries no token and keeps
 * the iframe sandbox unchanged. Reporting is frame-coalesced; apply messages
 * are accepted only from the parent and only on this mount's channel.
 */
export function htmlPreviewScrollBridgeScript(channel: string): string {
  const encodedChannel = JSON.stringify(channel);
  const reportKind = JSON.stringify(HTML_PREVIEW_SCROLL_REPORT);
  const applyKind = JSON.stringify(HTML_PREVIEW_SCROLL_APPLY);
  return `(() => {
    const channel = ${encodedChannel};
    const reportKind = ${reportKind};
    const applyKind = ${applyKind};
    let frame = 0;
    let layoutChanged = false;
    const scrolling = () => document.scrollingElement || document.documentElement;
    const clamp = (ratio) => Math.min(1, Math.max(0, ratio));
    const report = () => {
      frame = 0;
      const root = scrolling();
      const ratio = clamp(root.scrollTop / Math.max(1, root.scrollHeight - innerHeight));
      parent.postMessage({ kind: reportKind, channel, ratio, layout: layoutChanged }, '*');
      layoutChanged = false;
    };
    const schedule = (layout = false) => {
      layoutChanged = layoutChanged || layout;
      if (!frame) frame = requestAnimationFrame(report);
    };
    addEventListener('scroll', () => schedule(false), { passive: true });
    addEventListener('load', () => schedule(true));
    const observer = new ResizeObserver(() => schedule(true));
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== parent || !data || data.kind !== applyKind ||
          data.channel !== channel || typeof data.ratio !== 'number' ||
          !Number.isFinite(data.ratio)) return;
      const root = scrolling();
      scrollTo(0, clamp(data.ratio) * Math.max(0, root.scrollHeight - innerHeight));
    });
    schedule(true);
  })();`;
}

/** Append the bridge after page content so its observers see the final body. */
export function appendHtmlPreviewScrollBridge(doc: Document, channel: string): void {
  const script = doc.createElement('script');
  script.textContent = htmlPreviewScrollBridgeScript(channel);
  (doc.body ?? doc.documentElement).appendChild(script);
}
