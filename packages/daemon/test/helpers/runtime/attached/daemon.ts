import { startDaemon } from '../../../../src/daemon.js';

// The sole lifecycle seam is an unavailable user manager. Keep the installed
// launcher, marker selection, detached dispatch, owner and reconciliation real.
const daemon = await startDaemon({
  home: process.env.PUDDLE_HOME,
  adapters: [],
  version: '0.4.0',
  runtime: {
    installed: true,
    run: async () => {
      throw new Error('Attached-lifetime fixture has no user service manager');
    },
  },
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().then(() => process.exit(0));
  });
