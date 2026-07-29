import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import { matchMathAt, renderMathHtml, type MathMacros } from './math';

/**
 * Markdown → HTML for the preview view (SPEC §8). Pure (no DOM), so the
 * parser configuration is unit-testable under vitest; sanitisation is NOT
 * done here — MarkdownPreview runs the output through DOMPurify, which needs
 * a browser DOM, before anything touches innerHTML.
 *
 * LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and ```math fences) renders through
 * KaTeX as an inline extension, so the maths is claimed BEFORE the emphasis
 * and escape rules can chew on `a_1` or `\left`. Maths inside a code span or
 * fence is untouched for the same reason: the walker never steps inside one.
 */

/**
 * Macros defined in one expression stay defined for the rest of the document
 * (`\gdef` in a preamble block, KaTeX auto-render's behaviour). Parsing is
 * synchronous, so this single table cannot interleave between documents.
 */
let macros: MathMacros = {};

const mathExtension: TokenizerAndRendererExtension = {
  name: 'math',
  level: 'inline',
  start(src: string) {
    const at = src.search(/\$|\\[([]/);
    return at < 0 ? undefined : at;
  },
  tokenizer(src: string) {
    const match = matchMathAt(src);
    if (!match) return undefined;
    return {
      type: 'math',
      raw: src.slice(0, match.length),
      text: match.tex,
      display: match.display,
    };
  },
  renderer(token) {
    return renderMathHtml(token.text ?? '', token.display === true, macros);
  },
};

const parser = new Marked({ gfm: true, breaks: false, async: false }).use({
  extensions: [mathExtension],
  renderer: {
    // ```math fences are GitHub's spelling of display maths; every other
    // language falls through to the stock renderer (`false`).
    code({ text, lang }: Tokens.Code) {
      return lang === 'math' ? renderMathHtml(text, true, macros) : false;
    },
  },
});

export function markdownToHtml(text: string): string {
  macros = {};
  return parser.parse(text) as string;
}
