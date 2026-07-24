import { marked } from 'marked';

/**
 * Markdown → HTML for the preview view (SPEC §8). Pure (no DOM), so the
 * parser configuration is unit-testable under vitest; sanitisation is NOT
 * done here — MarkdownPreview runs the output through DOMPurify, which needs
 * a browser DOM, before anything touches innerHTML.
 */
const parser = marked.setOptions({ gfm: true, breaks: false, async: false });

export function markdownToHtml(text: string): string {
  return parser.parse(text) as string;
}
