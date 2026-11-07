import { useEffect, useRef, useState } from 'react';
import type { ThemeName } from '../../../lib/appearance/theme';
import type { RipplePart } from './buffer';
import { useInlineMathToggle } from '../rich-output/inline-math-toggle';
import { renderRichContent } from '../rich-output/render-rich-content';

/** Reuse the terminal/Markdown renderers at natural reading size, with shared direct inline-maths interaction. */
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
  const inline = kind === 'math' && !display;
  const [ready, setReady] = useState(false);
  const { sourceVisible, props } = useInlineMathToggle(source, ready);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !active) return;
    const abort = new AbortController();
    setReady(false);
    body.textContent = source;
    void renderRichContent(body, { kind, source, display }, theme, abort.signal)
      .then(() => {
        if (!abort.signal.aborted) setReady(true);
      })
      .catch(() => {
        if (!abort.signal.aborted) body.textContent = source;
      });
    return () => abort.abort();
  }, [source, kind, display, theme, active]);
  return (
    <span
      data-ripple-rich={kind}
      className={
        display
          ? 'ripple-rich-display'
          : inline
            ? `inline-math-toggle${sourceVisible ? ' font-mono' : ''}`
            : undefined
      }
      {...(inline ? props : {})}
    >
      <span ref={bodyRef} hidden={inline && sourceVisible} />
      {inline && sourceVisible && <span>{source}</span>}
    </span>
  );
}
