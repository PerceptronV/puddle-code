import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/features/editor/markdown';

describe('markdownToHtml', () => {
  it('renders headings, emphasis, and links', () => {
    const html = markdownToHtml('# Title\n\nSome *very* [linked](https://example.com) text.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>very</em>');
    expect(html).toContain('<a href="https://example.com">linked</a>');
  });

  it('renders GFM tables and fenced code', () => {
    const html = markdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<code class="language-js">');
  });

  it('does not treat single newlines as hard breaks (breaks: false)', () => {
    expect(markdownToHtml('one\ntwo')).not.toContain('<br');
  });

  it('passes raw HTML through for the sanitiser to handle', () => {
    // Sanitisation is DOMPurify's job in FilePreview (needs a browser DOM);
    // the parser itself must not be relied on to strip anything.
    expect(markdownToHtml('hello <script>alert(1)</script>')).toContain('<script>');
  });
});
