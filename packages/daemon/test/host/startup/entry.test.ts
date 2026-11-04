import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildHostUpdateEntry } from '../../helpers/host-update-entry.js';
import { expect, it } from 'vitest';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { acceptedCheckpointUpdate } from '../../helpers/update-checkpoint.js';

it('runs the pinned startup entry, refuses unsafe starts and cleans up a disconnected startup', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-start-entry-')));
  const root = join(home, 'bin/versions/0.4.0~ABC123');
  const entry = join(root, 'daemon/host-update.mjs');
  const node = join(root, 'bin/node');
  let claim: ReturnType<typeof acquireHostClaim> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await buildHostUpdateEntry(root);
    symlinkSync(root, join(home, 'bin/current'));
    const env = { HOME: home, PUDDLE_HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
    const invoke = (args: string[]) =>
      promisify(execFile)(node, [entry, ...args], { env, timeout: 10_000 });
    expect((await invoke(['--version'])).stdout).toBe('puddle host updater 0.4.0\n');
    claim = acquireHostClaim(home, 'daemon-controller');
    const rejected = { code: 1, stdout: '', stderr: 'The selected daemon could not be started\n' };
    await expect(invoke(['--home', home, '--start-daemon'])).rejects.toMatchObject(rejected);
    claim.release();
    claim = undefined;
    const { operation } = acceptedCheckpointUpdate(home);
    const before = readFileSync(join(home, 'updates/operations.json'));
    await expect(invoke(['--home', home, '--start-daemon'])).rejects.toMatchObject(rejected);
    expect(readFileSync(join(home, 'updates/operations.json'))).toEqual(before);
    expect(new HostUpdateOperations(home).read()?.id).toBe(operation.id);
    acquireInstallationLock(home).release();
    expect(existsSync(join(home, 'puddle.db'))).toBe(false);
    expect(existsSync(join(home, 'supervisor'))).toBe(false);
    // Begin a clean fixture lifecycle after checking the synthetic interrupted update.
    rmSync(join(home, 'updates'), { recursive: true, force: true });
    const commands = join(home, 'commands');
    mkdirSync(commands);
    writeFileSync(join(home, 'supervisor'), 'systemd', { mode: 0o600 });
    writeFileSync(
      join(commands, 'systemctl'),
      `#!${node}
const fs = require('node:fs'), path = require('node:path');
const home = process.env.PUDDLE_HOME, args = process.argv.slice(2);
if (args[1] === 'cat') {
  if (process.env.PUDDLE_TEST_START_DELAY) {
    fs.writeFileSync(path.join(home, 'probe'), String(process.pid));
    setInterval(() => { if (fs.existsSync(path.join(home, 'probe-release'))) process.exit(0); }, 20);
  } else console.log('[Service]\\nExisting=yes');
} else if (args.includes('--property=ExecStart')) {
  const wrapper = path.join(home, 'bin/current/puddled');
  console.log('{ path=' + wrapper + ' ; argv[]=' + wrapper + ' ; ignore_errors=no ; pid=0 }');
} else if (args[1] === 'show' && args.at(-1) === 'puddled.service') {
  console.log('Id=puddled.service\\nLoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nNeedDaemonReload=no');
  if (args.some(arg => arg.includes(',Result'))) console.log('Result=success');
} else if (args[1] === 'start') fs.appendFileSync(path.join(home, 'starts'), 'start\\n');
else if (args[1] !== 'show') process.exit(2);
`,
      { mode: 0o700 },
    );
    env.PATH = commands + ':/usr/bin:/bin';
    await invoke(['--home', home, '--start-daemon']);
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
    child = spawn(node, [entry, '--home', home, '--start-daemon'], {
      env: { ...env, PUDDLE_TEST_START_DELAY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stopped = once(child, 'exit');
    await expect
      .poll(
        () => {
          if (child!.exitCode !== null || child!.signalCode !== null)
            throw new Error('Startup exited before the probe');
          return existsSync(join(home, 'probe'));
        },
        { timeout: 5000 },
      )
      .toBe(true);
    child.kill('SIGHUP');
    expect((await stopped)[0]).toBe(1);
    acquireInstallationLock(home).release();
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
    const released = acquireHostClaim(home, 'daemon-controller');
    released.release();
    rmSync(join(home, 'probe'));
    child = spawn(node, [entry, '--home', home, '--start-daemon'], {
      env: { ...env, PUDDLE_TEST_START_DELAY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killed = once(child, 'exit');
    await expect.poll(() => existsSync(join(home, 'probe')), { timeout: 5000 }).toBe(true);
    child.kill('SIGKILL');
    expect((await killed)[1]).toBe('SIGKILL');
    expect(() => acquireInstallationLock(home)).toThrow('Another installer');
    writeFileSync(join(home, 'probe-release'), 'finish');
    await expect
      .poll(
        () => {
          try {
            acquireInstallationLock(home).release();
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
  } finally {
    claim?.release();
    writeFileSync(join(home, 'probe-release'), 'finish');
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    }
    await expect
      .poll(
        () => {
          try {
            acquireInstallationLock(home).release();
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    rmSync(home, { recursive: true, force: true });
  }
});
