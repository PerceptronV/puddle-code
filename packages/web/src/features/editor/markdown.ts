import MarkdownIt, { type Env, type StateInline, type Token } from 'markdown-it';
import { matchMathAt, renderMathHtml, type MathMacros } from './math';
import { SOURCE_END_LINE_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE } from './source-anchor-map';

interface MarkdownEnvironment extends Env {
  mathMacros: MathMacros;
}

function markdownEnvironment(env: Env | undefined): MarkdownEnvironment {
  if (env && 'mathMacros' in env) return env as MarkdownEnvironment;
  return { mathMacros: {} };
}

/** Claim maths before Markdown escape/emphasis processing can alter its TeX. */
function mathRule(state: StateInline, silent: boolean): boolean {
  const match = matchMathAt(state.src, state.pos);
  if (!match || state.pos + match.length > state.posMax) return false;
  if (!silent) {
    const token = state.push('math', '', 0);
    token.content = match.tex;
    token.meta = { display: match.display };
  }
  state.pos += match.length;
  return true;
}

function mathIsDisplay(token: Token): boolean {
  return (
    typeof token.meta === 'object' &&
    token.meta !== null &&
    'display' in token.meta &&
    token.meta.display === true
  );
}

const parser = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: true,
  typographer: false,
});

parser.inline.ruler.before('escape', 'puddle_math', mathRule);
parser.renderer.rules.math = (tokens, index, _options, env) => {
  const token = tokens[index]!;
  return renderMathHtml(token.content, mathIsDisplay(token), markdownEnvironment(env).mathMacros);
};

const defaultFence = parser.renderer.rules.fence;
parser.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();
  if (language !== 'math') {
    return defaultFence
      ? defaultFence(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  }
  const attributes = renderer.renderAttrs(token);
  return `<div${attributes}>${renderMathHtml(
    token.content,
    true,
    markdownEnvironment(env).mathMacros,
  )}</div>\n`;
};

/**
 * markdown-it block tokens carry zero-based `[start, end)` source maps. Add
 * those coordinates to the elements it renders so the preview can measure
 * the real, reflowed DOM just as VS Code's Markdown preview does.
 */
parser.core.ruler.after('block', 'puddle_source_lines', (state) => {
  for (const token of state.tokens) {
    if (!token.map || token.hidden || token.tag === '' || token.nesting < 0) continue;
    token.attrSet(SOURCE_LINE_ATTRIBUTE, String(token.map[0] + 1));
    token.attrSet(SOURCE_END_LINE_ATTRIBUTE, String(token.map[1] + 1));
  }
});

// markdown-it deliberately keeps task lists outside CommonMark. Preserve the
// GFM behaviour Puddle's former Marked renderer exposed with this tiny rule
// instead of adding another plugin dependency for one input transformation.
parser.core.ruler.after('inline', 'puddle_task_lists', (state) => {
  let listDepth = 0;
  for (const token of state.tokens) {
    if (token.type === 'list_item_open') listDepth += 1;
    else if (token.type === 'list_item_close') listDepth -= 1;
    else if (token.type === 'inline' && listDepth > 0) {
      const first = token.children?.[0];
      const match = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (!first || !match) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${match[1]!.toLowerCase() === 'x' ? ' checked' : ''}> `;
      token.children!.unshift(checkbox);
    }
  }
});

/**
 * Markdown → annotated HTML for the preview (SPEC §8). Sanitisation remains
 * MarkdownPreview's responsibility because DOMPurify needs a browser DOM.
 * Each render owns its macro table, so definitions never leak between files.
 */
export function markdownToHtml(text: string): string {
  return parser.render(text, { mathMacros: {} } satisfies MarkdownEnvironment);
}
