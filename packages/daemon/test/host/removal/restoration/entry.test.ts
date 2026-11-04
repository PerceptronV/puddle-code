import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { buildHostUpdateEntry } from '../../../helpers/host-update-entry.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';

it('runs pinned removal inspection, explicit restoration and ordinary startup through the built entry', async () => {
  const f = removalInstallationFixture('systemd');
  try {
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    const id = operation.read().id;
    await operation.stop('daemon');
    const controller = f.guard.acquireController();
    try {
      await operation.unregister('daemon');
    } finally {
      controller.release();
    }
    f.guard.release();
    const { node, entry } = await buildHostUpdateEntry(f.release);
    const commands = join(f.home, 'commands');
    mkdirSync(commands);
    writeFileSync(join(f.home, 'supervisor'), 'systemd', { mode: 0o600 });
    writeFileSync(
      join(commands, 'systemctl'),
      `#!${node}
const fs = require('node:fs'), path = require('node:path');
const home = process.env.PUDDLE_HOME, args = process.argv.slice(2);
const file = path.join(home, '.config/systemd/user/puddled.service');
const enabled = path.join(home, 'enabled');
const property = args.find(arg => arg.startsWith('--property='))?.slice(11);
if (args[1] === 'cat') process.stdout.write('# ' + file + '\\n' + fs.readFileSync(file, 'utf8'));
else if (args[1] === 'enable') fs.writeFileSync(enabled, 'yes');
else if (args[1] === 'start') fs.appendFileSync(path.join(home, 'starts'), 'start\\n');
else if (property === 'FragmentPath') console.log(file);
else if (property === 'UnitFileState') console.log(fs.existsSync(enabled) ? 'enabled' : 'disabled');
else if (property === 'ExecStart') console.log('{ path=' + path.join(home, 'bin/current/puddled') + ' ; argv[]=puddled }');
else if (property) {
  const values = { Id: 'puddled.service', LoadState: fs.existsSync(file) ? 'loaded' : 'not-found',
    ActiveState: 'inactive', SubState: 'dead', MainPID: '0', NeedDaemonReload: 'no', Result: 'success', Version: '254' };
  console.log(property.split(',').map(key => key + '=' + values[key]).join('\\n'));
} else if (!['show-environment', 'daemon-reload'].includes(args[1])) process.exit(2);
`,
      { mode: 0o700 },
    );
    const env = {
      HOME: f.home,
      PUDDLE_HOME: f.home,
      PATH: commands + ':/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
    };
    const invoke = (...args: string[]) =>
      promisify(execFile)(node, [entry, '--home', f.home, ...args], { env, timeout: 15_000 });
    expect(JSON.parse((await invoke('--inspect-removal')).stdout)).toEqual({
      state: 'removed',
      id,
    });
    const rejected = {
      code: 1,
      stdout: '',
      stderr: 'The recorded host removal could not be inspected or restored\n',
    };
    await expect(invoke('--restore-services', randomUUID())).rejects.toMatchObject(rejected);
    await expect(invoke('--restore-services', id, '--resume')).rejects.toMatchObject(rejected);
    expect(existsSync(f.file)).toBe(false);
    await invoke('--restore-services', id);
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(existsSync(join(f.home, 'starts'))).toBe(false);
    expect(JSON.parse((await invoke('--inspect-removal')).stdout)).toEqual({
      state: 'restored',
      id,
    });
    await expect(invoke('--restore-services', id)).rejects.toMatchObject(rejected);
    await invoke('--start-daemon');
    expect(readFileSync(join(f.home, 'starts'), 'utf8')).toBe('start\n');
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
  } finally {
    f.close();
  }
});
