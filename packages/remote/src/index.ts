import { readConfig } from './config.js';
import { startRemoteService } from './server.js';

const remote = await startRemoteService(readConfig(process.env));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void remote.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
