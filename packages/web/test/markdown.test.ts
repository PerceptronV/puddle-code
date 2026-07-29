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

  it('typesets inline and display maths', () => {
    expect(markdownToHtml('mass $E=mc^2$ today')).toContain('class="katex"');
    expect(markdownToHtml('$$\n\\int_0^1 x\\,dx\n$$')).toContain('math math-display');
    expect(markdownToHtml('\\(a+b\\)')).toContain('class="katex"');
    expect(markdownToHtml('```math\nx^2\n```')).toContain('math math-display');
  });

  it('claims maths before the emphasis and escape rules can chew on it', () => {
    const html = markdownToHtml('$a_1 + b_2$');
    expect(html).not.toContain('<em>');
    expect(html).toContain('aria-label="a_1 + b_2"');
  });

  it('leaves maths inside code spans and fences as text', () => {
    expect(markdownToHtml('`$x$`')).not.toContain('class="katex"');
    expect(markdownToHtml('```\n$x$\n```')).not.toContain('class="katex"');
  });

  it('leaves prose dollars alone', () => {
    expect(markdownToHtml('it costs $5 or $10 today')).not.toContain('class="katex"');
  });

  it('keeps macros within one document', () => {
    // `\gdef` in a preamble expression holds for the rest of the file...
    expect(markdownToHtml('$\\gdef\\pud{\\alpha}$ then $\\pud$')).not.toContain('var(--danger)');
    // ...and never leaks into the next one (undefined macros print in the
    // error colour).
    expect(markdownToHtml('$\\pud$')).toContain('var(--danger)');
  });

  it('passes raw HTML through for the sanitiser to handle', () => {
    // Sanitisation is DOMPurify's job in FilePreview (needs a browser DOM);
    // the parser itself must not be relied on to strip anything.
    expect(markdownToHtml('hello <script>alert(1)</script>')).toContain('<script>');
  });
});
