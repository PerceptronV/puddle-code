import { useEffect, useRef } from 'react';
import type { ThemeName } from '../../../lib/appearance/theme';
import type { RipplePart } from './buffer';
import { renderRichContent } from '../rich-output/render-rich-content';

/** Reuse the terminal/Markdown renderers at natural reading size, without source switches. */
export function RippleRichPart({
  part,
  theme,
  active,
}: {
  part: Exclude<RipplePart, { kind: 'text' }>;
  theme: ThemeName;
  active: boolean;
}) {
  const bodyRef = useRef<HTMLSpanElement>(null);
  const { kind, source, display } = part;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !active) return;
    const abort = new AbortController();
    body.textContent = source;
    void renderRichContent(body, { kind, source, display }, theme, abort.signal).catch(() => {
      if (!abort.signal.aborted) body.textContent = source;
    });
    return () => abort.abort();
  }, [source, kind, display, theme, active]);
  return (
    <span
      ref={bodyRef}
      data-ripple-rich={kind}
      className={display ? 'ripple-rich-display' : undefined}
    />
  );
}
