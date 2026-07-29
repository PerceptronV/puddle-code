/// <reference types="vite/client" />

/**
 * KaTeX's stylesheet with its woff2 faces baked in as data URIs, built by
 * `plugins/katex-css.ts` — the form the sandboxed HTML preview needs, since a
 * null-origin document cannot load a font from this origin.
 */
declare module 'virtual:katex-inline-css' {
  const css: string;
  export default css;
}
