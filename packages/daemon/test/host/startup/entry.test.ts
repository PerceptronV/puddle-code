import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  constants,
  copyFileSync,
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { acceptedCheckpointUpdate } from '../../helpers/update-checkpoint.js';

it('runs the pinned startup entry, refuses unsafe starts and cleans up a disconnected startup', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-start-entry-')));
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
  const root = join(home, 'bin/versions/0.4.0~ABC123');
  const entry = join(root, 'daemon/host-update.mjs');
  const node = join(root, 'bin/node');
  let claim: ReturnType<typeof acquireHostClaim> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(node), { recursive: true, mode: 0o700 });
    copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
    writeFileSync(join(root, 'daemon/install.sh'), '');
    symlinkSync(root, join(home, 'bin/current'));
    symlinkSync(join(repo, 'packages/daemon/node_modules'), join(root, 'daemon/node_modules'));
    await build({
      entryPoints: [join(repo, 'packages/daemon/src/updates/worker/index.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
      alias: {
        '@puddle/shared/node/host-control': join(repo, 'packages/shared/src/node/host-control.ts'),
        '@puddle/shared/node': join(repo, 'packages/shared/src/node/security.ts'),
        '@puddle/shared': join(repo, 'packages/shared/src/index.ts'),
      },
      // Run the systemd branch against a deterministic fake command on any test OS.
      // Native SQLite claims/processes are real; no installed supervisor is contacted.
      define: {
        __PUDDLED_VERSION__: '"0.4.0"',
        __PUDDLER_VERSION__: '"0.4.0"',
        'process.platform': '"linux"',
      },
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      logLevel: 'warning',
    });
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
    expect(existsSync(join(home, 'bin/.install-lock'))).toBe(false);
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
    fs.writeFileSync(path.join(home, 'probe'), 'ready');
    setInterval(() => {}, 1000);
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
    expect(existsSync(join(home, 'bin/.install-lock'))).toBe(false);
    expect(readFileSync(join(home, 'starts'), 'utf8')).toBe('start\n');
    const released = acquireHostClaim(home, 'daemon-controller');
    released.release();
  } finally {
    claim?.release();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
