import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// A deterministic service manager for the bundled upgrade journey. Every process
// and record belongs to the temporary home; no native service is addressed.
const home = process.env.PUDDLE_HOME!;
const directory = join(home, 'test-services');
const [scope, action, ...args] = process.argv.slice(2);
if (scope !== '--user') throw new Error('Fixture only supports user services');
const name = args.at(-1)!;
const pidFile = (service: string) => join(directory, `${service}.pid`);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
const pid = () => (existsSync(pidFile(name)) ? Number(readFileSync(pidFile(name), 'utf8')) : 0);
if (action === 'link') {
  writeFileSync(join(directory, `${basename(name)}.definition`), name);
} else if (action === 'daemon-reload') {
  // Definitions are read afresh on every observation.
} else if (action === 'cat') {
  process.stdout.write(`[Service]\nExecStart=${home}/bin/current/puddled\nRestart=always\n`);
} else if (action === 'show') {
  if (args.includes('--property=Version')) process.stdout.write('Version=fixture\n');
  else {
    const running = pid() > 0 && alive(pid());
    const requested = args
      .find((arg) => arg.startsWith('--property='))
      ?.slice('--property='.length)
      .split(',');
    process.stdout.write(
      [
        `Id=${name}`,
        'LoadState=loaded',
        `ActiveState=${running ? 'active' : 'inactive'}`,
        `SubState=${running ? 'running' : 'dead'}`,
        `MainPID=${running ? pid() : 0}`,
        `InvocationID=${String(pid()).padStart(32, '0')}`,
        `ControlGroup=/puddle-test/${name}`,
        'NeedDaemonReload=no',
        'CanStart=yes',
        'CanStop=yes',
      ]
        .filter((line) => !requested || requested.includes(line.slice(0, line.indexOf('='))))
        .join('\n') + '\n',
    );
  }
} else if (action === 'start') {
  if (pid() && alive(pid())) throw new Error('Duplicate service start');
  let command: string[];
  if (name === 'puddled.service') {
    const release = realpathSync(join(home, 'bin/current'));
    command = [join(release, 'bin/node'), join(release, 'daemon/puddled.mjs')];
  } else {
    const path = readFileSync(join(directory, `${name}.definition`), 'utf8');
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((value) => value.startsWith('ExecStart='));
    if (!line) throw new Error('Missing fixture service command');
    command = [...line.slice('ExecStart='.length).matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
      ([value]) => JSON.parse(value) as string,
    );
  }
  const output = openSync(join(directory, `${name}.log`), 'a', 0o600);
  try {
    const child = spawn(command[0]!, command.slice(1), {
      env: process.env,
      detached: true,
      stdio: ['ignore', output, output],
    });
    await once(child, 'spawn');
    writeFileSync(pidFile(name), String(child.pid));
    appendFileSync(join(directory, 'mutations'), `start ${name} ${child.pid}\n`);
    child.unref();
  } finally {
    closeSync(output);
  }
} else if (action === 'stop') {
  const current = pid();
  if (current && alive(current)) {
    process.kill(current, 'SIGTERM');
    const deadline = Date.now() + 20_000;
    while (alive(current) && Date.now() < deadline) await delay(20);
    if (alive(current)) throw new Error('Fixture service did not stop');
  }
  appendFileSync(join(directory, 'mutations'), `stop ${name} ${current}\n`);
} else if (action === 'disable') {
  // Runtime cleanup follows a positively ended owner. Preserve the fixture record.
} else throw new Error(`Unsupported fixture service action: ${action}`);
