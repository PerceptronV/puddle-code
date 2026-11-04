/// <reference types="vite/client" />

/** Exact release content embedded by the common release packaging helper. */
declare const __PUDDLE_RELEASE_VERSION__: string;
declare const __PUDDLE_RELEASE_NOTES__: string | null;

/**
 * KaTeX's stylesheet with its woff2 faces baked in as data URIs, built by
 * `plugins/katex-css.ts` — the form the sandboxed HTML preview needs, since a
 * null-origin document cannot load a font from this origin.
 */
declare module 'virtual:katex-inline-css' {
  const css: string;
  export default css;
}

declare module 'virtual:notebook-widget-runtime' {
  const script: string;
  export default script;
}
