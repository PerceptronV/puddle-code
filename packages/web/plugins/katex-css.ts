import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The two shapes the maths previews need KaTeX's stylesheet in (SPEC §8):
 *
 * 1. For the app itself, `katex.min.css` imported normally — trimmed to its
 *    woff2 sources, since the stock file also lists woff and ttf fallbacks and
 *    Vite would emit all sixty font files (1.1 MB) to serve the twenty a
 *    browser actually fetches.
 * 2. For the HTML preview, `virtual:katex-inline-css` — the same stylesheet
 *    with the fonts baked in as data URIs. That preview is a sandboxed
 *    null-origin iframe, which cannot load a font from this origin (a
 *    cross-origin font needs CORS it will never get), so its document has to
 *    carry the faces itself, exactly as it carries its images.
 */

const require = createRequire(import.meta.url);
const KATEX_CSS = require.resolve('katex/dist/katex.min.css');
const FONT_DIR = resolve(dirname(KATEX_CSS), 'fonts');

const VIRTUAL_ID = 'virtual:katex-inline-css';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

export function katexCss(): Plugin[] {
  return [
    {
      name: 'puddle:katex-woff2-only',
      enforce: 'pre', // before Vite's CSS plugin resolves the url()s to assets
      transform(code, id) {
        if (!id.endsWith('katex.min.css')) return undefined;
        return { code: woff2Only(code), map: null };
      },
    },
    {
      name: 'puddle:katex-inline-css',
      resolveId(id) {
        return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
      },
      load(id) {
        if (id !== RESOLVED_ID) return undefined;
        return `export default ${JSON.stringify(inlineFonts(readFileSync(KATEX_CSS, 'utf8')))};`;
      },
    },
  ];
}

/** Drop the woff and truetype sources from every @font-face. */
function woff2Only(css: string): string {
  return css.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
}

function inlineFonts(css: string): string {
  return woff2Only(css).replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_whole, file: string) => {
    const bytes = readFileSync(resolve(FONT_DIR, file));
    return `url(data:font/woff2;base64,${bytes.toString('base64')})`;
  });
}
