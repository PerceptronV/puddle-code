import { RuntimeHost } from '../../src/runtime/host.js';

const args = process.argv.slice(2);
const host = await RuntimeHost.start(args[1]!, args[3]!, 'runtime-test');
// Keep this isolated process alive after graceful execution shutdown so its
// process-memory claim, rather than eventual automatic exit, can be observed.
const hold = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  void host.stop().then(() => process.stdout.write('execution-stopped\n'));
});
process.on('SIGUSR1', () => {
  clearInterval(hold);
  process.exit(0);
});
