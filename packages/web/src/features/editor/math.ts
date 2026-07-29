import katex, { type KatexOptions } from 'katex';

/**
 * LaTeX for the preview views (SPEC §8): delimiter scanning plus the KaTeX
 * call, shared by the markdown parser extension (`markdown.ts`) and the HTML
 * document walker (`math-dom.ts`). Pure and DOM-free — KaTeX renders from font
 * metrics without measuring anything, so this runs under vitest and, more
 * importantly, over a detached `DOMParser` document.
 *
 * KaTeX rather than MathJax because a preview re-renders on every keystroke of
 * the shared editor model: KaTeX is synchronous (no typeset pass, no reflow
 * flash) and needs no live document, which is what lets the HTML preview's
 * maths be rendered HERE, in the parent, before the sandboxed iframe ever sees
 * the document — a null-origin iframe cannot be handed a typesetter to run.
 */

/** A LaTeX span found at some offset: what to render, and how much it ate. */
export type MathMatch = { length: number; tex: string; display: boolean };

/** Macro table shared across one document's expressions (`\gdef`, `\newcommand`). */
export type MathMacros = NonNullable<KatexOptions['macros']>;

/** Opener, closer, display mode — longest opener first, so `$$` beats `$`. */
const PAIRS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['$$', '$$', true],
  ['\\[', '\\]', true],
  ['\\(', '\\)', false],
  ['$', '$', false],
];

/** Characters that can open maths — the cheap test before `matchMathAt`. */
export function couldOpenMath(ch: string): boolean {
  return ch === '$' || ch === '\\';
}

/**
 * The maths starting exactly at `at`, or null. `$…$` follows pandoc's rules
 * for telling maths from prose currency: no whitespace just inside either
 * delimiter, no digit straight after the closing `$` (so `$5-$7` stays prose),
 * and no blank line inside. Escaped delimiters (`\$`) never close a span.
 */
export function matchMathAt(src: string, at = 0): MathMatch | null {
  for (const [open, close, display] of PAIRS) {
    if (!src.startsWith(open, at)) continue;
    const from = at + open.length;
    const end = findClosing(src, from, close);
    if (end < 0) continue;
    const tex = src.slice(from, end);
    if (tex.trim() === '' || /\n[ \t]*\n/.test(tex)) continue;
    if (open === '$' && !isTightSpan(tex, src[end + close.length])) continue;
    return { length: end + close.length - at, tex, display };
  }
  return null;
}

/** The next maths at or after `from`, or null — the text-node scanner's step. */
export function findMath(text: string, from = 0): (MathMatch & { start: number }) | null {
  for (let i = from; i < text.length; i++) {
    if (!couldOpenMath(text[i]!)) continue;
    const match = matchMathAt(text, i);
    if (match) return { ...match, start: i };
  }
  return null;
}

/**
 * The closing delimiter's offset, or -1. A backslash escapes the character
 * after it, so `\$` cannot close `$…$` — but the closer is tested first, so a
 * `\]` still closes `\[…\]`.
 */
function findClosing(src: string, from: number, close: string): number {
  for (let i = from; i < src.length; i++) {
    if (src.startsWith(close, i)) return i;
    if (src[i] === '\\') i++;
  }
  return -1;
}

function isTightSpan(tex: string, after: string | undefined): boolean {
  return !/^\s|\s$/.test(tex) && !(after !== undefined && /\d/.test(after));
}

/**
 * One expression as HTML. `output: 'html'` (not KaTeX's default HTML+MathML)
 * because the markdown preview's output goes through DOMPurify, which strikes
 * `<semantics>`/`<annotation>` out of MathML by design — rather than widen the
 * sanitiser on the origin that holds the daemon token, the visual output is
 * wrapped in `role="math"` carrying the source as its label, which is what a
 * screen reader then reads (KaTeX marks its own spans `aria-hidden`).
 *
 * A malformed expression is never fatal: KaTeX renders the source in place,
 * with the parse error as its `title`. Its colour has to travel in KaTeX's own
 * inline style (which a stylesheet rule could not outrank), so it goes as the
 * token reference — themed here, and harmlessly inherited inside the iframe,
 * where the token is undefined. `trust` stays false: `\href`/`\includegraphics`
 * in a worktree document must not mint URLs, as the HTML preview has no
 * sanitiser.
 */
export function renderMathHtml(tex: string, display: boolean, macros: MathMacros = {}): string {
  const html = katex.renderToString(tex, {
    displayMode: display,
    output: 'html',
    throwOnError: false,
    errorColor: 'var(--danger)',
    strict: false, // a preview must not console-warn on every keystroke
    trust: false,
    macros,
  });
  const cls = display ? 'math math-display' : 'math';
  return `<span class="${cls}" role="math" aria-label="${escapeAttr(tex)}">${html}</span>`;
}

/** Display maths blocks; the app styles it in app.css, the iframe gets this. */
export const MATH_LAYOUT_CSS = '.math-display{display:block}';

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
