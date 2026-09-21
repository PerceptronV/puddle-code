import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { katexCss } from './plugins/katex-css';

// Keep production builds independent of the development gateway's CLI dependencies.
export default defineConfig({
  server: { host: '127.0.0.1' },
  plugins: [react(), tailwindcss(), katexCss()],
});
