import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../../scripts/lib/releases/notes.mjs';
import { katexCss } from './plugins/katex-css';
import { notebookWidgets } from './plugins/notebook-widgets';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const version: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

// Keep production builds independent of the development gateway's CLI dependencies.
export default defineConfig({
  server: { host: '127.0.0.1' },
  plugins: [react(), tailwindcss(), katexCss(), notebookWidgets()],
  define: {
    __PUDDLE_RELEASE_VERSION__: JSON.stringify(version),
    __PUDDLE_RELEASE_NOTES__: JSON.stringify(releaseNotes(repo, version)),
  },
});
