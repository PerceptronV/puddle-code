import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  const result = await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const { editorLanguages, languageForPath } =
      await import('/src/features/editor/monaco/languages.ts');
    const source = String.raw`\documentclass{article} % comment
Text with \% escaped and $x_1 + 2$ plain.
\begin{equation}
x^2 = \frac{1}{2}
\end{equation}
Plain prose
\[
y = 3
\]
Plain again
\begin{verbatim}
% literal $x$ \command
\end{verbatim}
\verb|% $literal$| % real comment
\(z + 4\) plain
$$
w = 5
$$
End.`;
    const model = monaco.editor.createModel(source, languageForPath('paper.tex'));
    try {
      const lines = source.split('\n');
      const tokens = monaco.editor.tokenize(source, model.getLanguageId()).map((tokens, index) =>
        tokens.map((token, i) => ({
          text: lines[index].slice(token.offset, tokens[i + 1]?.offset),
          type: token.type,
        })),
      );
      return {
        language: model.getLanguageId(),
        extensions: ['paper.tex', 'paper.ltx', 'style.sty', 'class.cls'].map(languageForPath),
        menu: editorLanguages().find(({ id }) => id === 'tex'),
        tokens,
      };
    } finally {
      model.dispose();
    }
  });
  assert.equal(result.language, 'tex');
  assert.deepEqual(result.extensions, ['tex', 'tex', 'tex', 'apex']);
  assert.equal(result.menu.label, 'TeX / LaTeX');
  const has = (line, text, type) =>
    assert.ok(
      result.tokens[line].some(
        (token) => token.text.includes(text) && token.type === `${type}.tex`,
      ),
      `Line ${line + 1} should highlight ${text} as ${type}: ${JSON.stringify(result.tokens[line])}`,
    );
  has(0, '\\documentclass', 'keyword');
  has(0, '% comment', 'comment');
  has(1, '\\%', 'keyword');
  assert.ok(result.tokens[1].every(({ type }) => type !== 'comment.tex'));
  has(1, '2', 'number');
  has(2, 'equation', 'type');
  has(3, '\\frac', 'keyword');
  has(3, '2', 'number');
  has(7, 'y', 'string');
  has(11, '% literal $x$ \\command', 'string');
  has(13, '\\verb|% $literal$|', 'string');
  has(13, '% real comment', 'comment');
  has(14, '4', 'number');
  has(16, '5', 'number');
  for (const line of [5, 9, 18])
    assert.ok(result.tokens[line].every(({ type }) => !type || type === '.tex'));
  console.log(
    'TeX detection, language menu, commands, escaped comments, multiline math and verbatim highlighting pass.',
  );
} finally {
  await browser.close();
}
