import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fake systemd only; commands are subprocesses but never contact an installed supervisor. */
export function scriptedRemovalSupervisor(
  home: string,
  node: string,
  running = false,
  commands = join(home, 'commands'),
) {
  mkdirSync(commands);
  if (running) writeFileSync(join(home, 'service-running'), 'yes');
  writeFileSync(
    join(commands, 'systemctl'),
    `#!${node}
const fs = require('node:fs'), path = require('node:path');
const home = process.env.PUDDLE_HOME, args = process.argv.slice(2);
const name = args.at(-1) === 'puddle-connector.service' ? 'puddle-connector.service' : 'puddled.service';
const file = path.join(home, '.config/systemd/user', name), enabled = path.join(home, 'enabled');
const runningFile = path.join(home, 'service-running');
const running = name === 'puddled.service' && fs.existsSync(runningFile);
const property = args.find(arg => arg.startsWith('--property='))?.slice(11);
if (args[1] === 'cat') process.stdout.write('# ' + file + '\\n' + fs.readFileSync(file, 'utf8'));
else if (args[1] === 'enable') fs.writeFileSync(enabled, 'yes');
else if (args[1] === 'disable') fs.rmSync(enabled, { force: true });
else if (args[1] === 'stop') fs.rmSync(runningFile, { force: true });
else if (args[1] === 'start') { fs.writeFileSync(runningFile, 'yes'); fs.appendFileSync(path.join(home, 'starts'), 'start\\n'); }
else if (property === 'FragmentPath') console.log(file);
else if (property === 'UnitFileState') console.log(fs.existsSync(enabled) ? 'enabled' : 'disabled');
else if (property === 'ExecStart') console.log('{ path=' + path.join(home, 'bin/current/puddled') + ' ; argv[]=puddled }');
else if (property) {
  const values = { Id: name, LoadState: fs.existsSync(file) ? 'loaded' : 'not-found',
    ActiveState: running ? 'active' : 'inactive', SubState: running ? 'running' : 'dead',
    MainPID: running ? '2000000000' : '0', NeedDaemonReload: 'no', Result: 'success', Version: '254',
    InvocationID: 'a'.repeat(32), ControlGroup: '/' + name, CanStart: 'yes', CanStop: 'yes' };
  console.log(property.split(',').map(key => key + '=' + values[key]).join('\\n'));
} else if (!['show-environment', 'daemon-reload'].includes(args[1])) process.exit(2);
`,
    { mode: 0o700 },
  );
  return { HOME: home, PUDDLE_HOME: home, PATH: commands + ':/usr/bin:/bin', LANG: 'en_US.UTF-8' };
}
