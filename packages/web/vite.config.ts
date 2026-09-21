import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cockpitGateway } from './plugins/cockpit-gateway';
import { katexCss } from './plugins/katex-css';

export default defineConfig({
  server: { host: '127.0.0.1' },
  plugins: [react(), tailwindcss(), katexCss(), cockpitGateway()],
});
