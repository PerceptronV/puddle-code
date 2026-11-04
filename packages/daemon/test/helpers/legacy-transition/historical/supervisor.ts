import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bootstrap-only adapter around the existing isolated worker supervisor fixture.
const home = process.env.PUDDLE_HOME!;
const manager = join(home, 'test-services/systemctl-worker');
const [scope, action, ...args] = process.argv.slice(2);
if (scope !== '--user') throw new Error('Only the isolated user manager is available');
const run = (...values: string[]) =>
  execFileSync(manager, ['--user', ...values], { stdio: 'inherit' });
const service = args.at(-1)?.replace(/^(puddled|puddle-connector)$/, '$1.service');
if (action === 'show-environment') {
  process.stdout.write('PUDDLE_TEST_MANAGER=1\n');
} else if (action === 'enable') {
  if (service !== 'puddled.service') throw new Error('Unexpected bootstrap service');
  if (args.includes('--now')) {
    const file = join(home, 'test-services', `${service}.pid`);
    let running = false;
    if (existsSync(file)) {
      try {
        process.kill(Number(readFileSync(file, 'utf8')), 0);
        running = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!running) run('start', service);
  }
} else if (action === 'restart') {
  if (service !== 'puddled.service') throw new Error('Unexpected bootstrap restart');
  run('stop', service);
  run('start', service);
} else run(action!, ...args);
