import { readFileSync } from 'node:fs';

/** Embed local CSS so the prompts retain their strict, network-free CSP. */
export function renderPrompt(name) {
  const tokens = readFileSync(
    new URL('../../web/src/styles/tokens.css', import.meta.url),
    'utf8',
  ).split('/* Ordinary-editor HEAD')[0];
  const controls = readFileSync(new URL('../src/prompt-appearance.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL(`../src/${name}.html`, import.meta.url), 'utf8');
  return html.replace(
    '<!-- shared-prompt-appearance -->',
    `<style>${tokens}\n${controls}</style>
    <script>
      const preference = new URLSearchParams(location.search).get('theme');
      const systemTheme = matchMedia('(prefers-color-scheme: dark)');
      const applyTheme = () => {
        document.documentElement.dataset.theme = preference === 'light' || preference === 'dark'
          ? preference : systemTheme.matches ? 'dark' : 'light';
      };
      applyTheme();
      systemTheme.addEventListener('change', applyTheme);
    </script>`,
  );
}
