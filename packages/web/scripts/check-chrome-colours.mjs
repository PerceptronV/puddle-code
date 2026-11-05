import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const literal = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.]/i;
const stockUtility =
  /\b(?:bg|text|border|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\b|\/)/;

/** Scan CSS declarations and application string values, not comments or artwork. */
export function chromeColourViolations(source, filename) {
  const found = [];
  const check = (text, offset, css = false) => {
    const colour = css
      ? literal.test(text)
      : /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([\s\S]*\))$/i.test(text.trim()) ||
        /(?:color|background|fill|stroke|shadow)\s*[:=][^;\n]*#[\da-f]{3,8}\b/i.test(text);
    if (
      colour ||
      stockUtility.test(text) ||
      /(?:bg|text|border|fill|stroke)-\[#[\da-f]{3,8}\]/i.test(text) ||
      /\b(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.]/i.test(text)
    )
      found.push(
        `${filename}:${source.slice(0, offset).split('\n').length}: use semantic colour tokens`,
      );
  };
  if (/\.(css|html)$/.test(filename)) {
    const css = filename.endsWith('.html')
      ? [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      : [{ 1: source, index: 0 }];
    for (const block of css) {
      const text = block[1].replace(/\/\*[\s\S]*?\*\//g, (comment) =>
        comment.replace(/[^\n]/g, ' '),
      );
      for (const match of text.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
        check(match[1], block.index + match.index, true);
    }
  } else {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        check(node.text, node.getStart(file));
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

export function checkChromeColours() {
  const failures = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Content/assets and fixtures have their own colour semantics.
        if (!['assets', 'dev', 'vendor', 'generated'].includes(entry.name)) walk(path);
      } else if (['.ts', '.tsx', '.css', '.html'].includes(extname(path))) {
        const name = relative(root, path);
        if (name === 'packages/web/src/styles/tokens.css') continue;
        failures.push(...chromeColourViolations(readFileSync(path, 'utf8'), name));
      }
    }
  };
  walk(join(root, 'packages/web/src'));
  walk(join(root, 'packages/desktop/src'));
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('check-chrome-colours: application chrome uses semantic colours');
}
