import { homedir } from 'node:os';
import { join } from 'node:path';
import { startConnector } from './runtime.js';
import { jsonLines } from '@puddle/shared/node';
import { administrativeRequest, configureConnector, resetConnectorIdentity } from './admin.js';

const home = process.env.PUDDLE_HOME ?? join(homedir(), '.puddle');

if (process.argv.includes('--version')) {
  process.stdout.write('puddle-connector remote protocol 1; daemon protocol 18.0\n');
} else if (process.argv.includes('--reset')) {
  await resetConnectorIdentity(home);
} else if (process.argv.includes('--admin') || process.argv.includes('--configure')) {
  let used = false;
  jsonLines(
    process.stdin,
    (value) => {
      if (used) return;
      used = true;
      const action = process.argv.includes('--configure')
        ? configureConnector
        : administrativeRequest;
      void action(home, value)
        .then((result) => {
          process.stdout.write(JSON.stringify(result) + '\n');
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `Puddle remote: ${error instanceof Error ? error.message : 'operation failed'}\n`,
          );
          process.exitCode = 1;
        });
    },
    () => {
      process.exitCode = 1;
    },
  );
} else {
  const connector = await startConnector(home);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void connector.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
