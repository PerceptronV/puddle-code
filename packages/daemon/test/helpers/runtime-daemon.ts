import { join } from 'node:path';
import { atomicPrivateJson } from '@puddle/shared/node';
import { startDaemon } from '../../src/daemon.js';

// Only the isolated test home and sanitised fixture environment are used.
const home = process.argv[3]!;
const daemon = await startDaemon({ home, port: 0, adapters: [] });
const lease = daemon.authority.create();
atomicPrivateJson(join(home, 'test-daemon-ready.json'), { port: daemon.port, token: lease.token });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().then(() => process.exit(0));
  });
