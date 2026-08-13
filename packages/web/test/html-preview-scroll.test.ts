import { describe, expect, it, vi } from 'vitest';
import {
  applyHtmlPreviewScroll,
  HTML_PREVIEW_SCROLL_APPLY,
  HTML_PREVIEW_SCROLL_REPORT,
  htmlPreviewScrollBridgeScript,
  htmlPreviewScrollReport,
} from '../src/features/editor/html-preview-scroll';

describe('sandboxed HTML preview scroll bridge', () => {
  const channel = 'mount-channel';
  const iframeWindow = {} as MessageEventSource;
  const event = (data: unknown, source: MessageEventSource | null = iframeWindow) => ({
    data,
    source,
  });

  it('accepts only the current iframe, channel, kind, and finite ratio', () => {
    const valid = { kind: HTML_PREVIEW_SCROLL_REPORT, channel, ratio: 0.4, layout: true };
    expect(htmlPreviewScrollReport(event(valid), iframeWindow, channel)).toEqual(valid);
    expect(
      htmlPreviewScrollReport(event(valid, {} as MessageEventSource), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, channel: 'stale' }), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(
        event({ ...valid, kind: HTML_PREVIEW_SCROLL_APPLY }),
        iframeWindow,
        channel,
      ),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, ratio: Number.NaN }), iframeWindow, channel),
    ).toBeNull();
    expect(
      htmlPreviewScrollReport(event({ ...valid, layout: 'yes' }), iframeWindow, channel),
    ).toBeNull();
  });

  it('posts only a clamped local apply message', () => {
    const postMessage = vi.fn();
    applyHtmlPreviewScroll({ postMessage } as never, channel, 2);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { kind: HTML_PREVIEW_SCROLL_APPLY, channel, ratio: 1 },
      '*',
    );
  });

  it('injects frame-limited reporting, reflow observation, and parent-only apply handling', () => {
    const script = htmlPreviewScrollBridgeScript(channel);
    expect(script).toContain('requestAnimationFrame');
    expect(script).toContain('ResizeObserver');
    expect(script).toContain('event.source !== parent');
    expect(script).toContain(JSON.stringify(channel));
    expect(script).toContain(HTML_PREVIEW_SCROLL_REPORT);
    expect(script).toContain(HTML_PREVIEW_SCROLL_APPLY);
    expect(script).not.toContain('token');
  });
});
