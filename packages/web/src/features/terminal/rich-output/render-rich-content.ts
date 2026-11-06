import type { ThemeName } from '../../../lib/appearance/theme';

/** Shared typesetting for fitted terminal overlays and the natural-size reader. */
export async function renderRichContent(
  body: HTMLElement,
  block: { kind: 'mermaid' | 'math'; source: string; display: boolean },
  theme: ThemeName,
  signal: AbortSignal,
  compact = false,
): Promise<void> {
  if (block.kind === 'mermaid') {
    const { renderMermaidDiagrams } =
      await import('../../editor/previews/markdown/markdown-mermaid');
    if (signal.aborted) return;
    const diagram = document.createElement('div');
    diagram.setAttribute('data-puddle-mermaid', '');
    diagram.textContent = block.source;
    body.replaceChildren(diagram);
    await renderMermaidDiagrams(body, theme, signal, compact);
    if (!signal.aborted && !diagram.querySelector('svg'))
      throw new Error('Unable to render Mermaid diagram');
  } else {
    const [{ renderMathHtml }, { default: DOMPurify }] = await Promise.all([
      import('../../editor/previews/markdown/math'),
      import('dompurify'),
      import('katex/dist/katex.min.css'),
    ]);
    if (signal.aborted) return;
    body.innerHTML = DOMPurify.sanitize(renderMathHtml(block.source, block.display));
    if (body.querySelector('.katex-error')) throw new Error('Unable to render LaTeX');
  }
}
