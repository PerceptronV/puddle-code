import { useId, useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { markdownToHtml } from '../../editor/previews/markdown/markdown';

/** A document preview, not an editor tab: no session, worktree or asset-fetch authority. */
export function ReleaseNotesPreview({ markdown }: { markdown: string }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const html = useMemo(() => {
    const body = DOMPurify.sanitize(markdownToHtml(markdown, id), {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      // Release notes never fetch local files or embedded remote resources.
      FORBID_TAGS: [
        'img',
        'video',
        'audio',
        'source',
        'iframe',
        'object',
        'embed',
        'style',
        'form',
      ],
      FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'action'],
    });
    for (const anchor of body.querySelectorAll('a')) {
      const href = anchor.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      } else if (!href.startsWith('#')) anchor.removeAttribute('href');
    }
    const container = document.createElement('div');
    container.append(body);
    return { __html: container.innerHTML };
  }, [markdown, id]);
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const href = (event.target as HTMLElement).closest('a')?.getAttribute('href');
    if (!href?.startsWith('#')) return;
    event.preventDefault();
    try {
      event.currentTarget
        .closest('[role="dialog"]')
        ?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
        ?.scrollIntoView({ block: 'nearest' });
    } catch {
      // An invalid authored fragment has no navigation effect.
    }
  };
  return (
    <div
      className="md-preview text-sm text-fg-secondary"
      onClick={click}
      dangerouslySetInnerHTML={html}
    />
  );
}
