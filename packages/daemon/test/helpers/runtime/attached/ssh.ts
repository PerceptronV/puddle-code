import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Exercise SshTransport's actual exec/channel lifecycle without network access.
// No inherited agent credentials, orchestration variables or personal HOME.
const [home, ...args] = process.argv.slice(2);
if (!home || !args.length) throw new Error('Missing isolated SSH fixture arguments');
const command = args.at(-1)!;
if (command === 'true') process.exit(0);
const child = spawn('/bin/sh', ['-c', command], {
  cwd: home,
  env: {
    HOME: home,
    PUDDLE_HOME: join(home, '.puddle'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  },
  stdio: 'inherit',
});
child.on('error', (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
child.on('close', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
