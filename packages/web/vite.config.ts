import { mergeConfig } from 'vite';
import { cockpitGateway } from './plugins/cockpit-gateway';
import buildConfig from './vite.build.config';

export default mergeConfig(buildConfig, {
  plugins: [cockpitGateway()],
});
