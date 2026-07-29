import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { katexCss } from './plugins/katex-css';

export default defineConfig({
  plugins: [react(), tailwindcss(), katexCss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7434',
      '/ws': { target: 'ws://127.0.0.1:7434', ws: true },
    },
  },
});
