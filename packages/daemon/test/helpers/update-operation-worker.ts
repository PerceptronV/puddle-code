import { HostUpdateOperations } from '../../src/updates/operations/store.js';

// Isolated process-lock probe; it never installs software or starts a daemon.
const [home, id, dispatch, preflight] = process.argv.slice(2);
try {
  const store = new HostUpdateOperations(home!);
  const operation = store.read(id)!;
  if (!operation) throw new Error('Update operation is missing');
  const execution = store.claimExecution(operation, dispatch!, preflight!);
  process.on('SIGTERM', () => {
    execution.release();
    process.exit(0);
  });
  process.stdout.write('claimed\n');
  setInterval(() => {}, 1000);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
