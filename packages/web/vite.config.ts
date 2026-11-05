import { defineConfig, mergeConfig } from 'vite';
import buildConfig from './vite.build.config';

export default defineConfig(async ({ mode }) => {
  if (mode === 'ui-preview')
    return mergeConfig(buildConfig, { server: { port: 5174, strictPort: true } });
  const { cockpitGateway } = await import('./plugins/cockpit-gateway');
  return mergeConfig(buildConfig, { plugins: [cockpitGateway()] });
});
