import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removalInstallationFixture } from './removal-service.js';
import { openDatabase } from '../../src/db/db.js';
import type { CompilationCommandRunner } from '../../src/compilation/process.js';

export function removalHostFixture(home?: string) {
  const f = removalInstallationFixture('systemd', home);
  mkdirSync(join(f.release, 'bin'));
  mkdirSync(join(f.release, 'daemon'));
  writeFileSync(join(f.release, 'bin/node'), 'fixture only', { mode: 0o700 });
  for (const file of ['host-update.mjs', 'connector.mjs', 'install.sh'])
    writeFileSync(join(f.release, 'daemon', file), 'fixture only');
  writeFileSync(join(f.home, 'supervisor'), 'systemd', { mode: 0o600 });
  writeFileSync(join(f.home, 'runtime.json'), JSON.stringify({ port: 7434, pid: f.pid }), {
    mode: 0o600,
  });
  openDatabase(join(f.home, 'puddle.db')).close();
  f.guard.release();
  const remote = { enabled: true, loseDisableReply: false, loseUnregisterReply: false };
  const remoteCalls: string[] = [];
  const run: CompilationCommandRunner = async (command) => {
    if (command.args[0]?.endsWith('/connector.mjs')) {
      remoteCalls.push(command.args[1]!);
      if (command.env?.PUDDLE_HOME !== f.home) throw new Error('Wrong remote target');
      if (command.args[1] === '--disable-all') {
        remote.enabled = false;
        if (remote.loseDisableReply) throw new Error('Lost disable reply');
      } else if (command.args[1] === '--continue-removal-disable') {
        if (!command.args[2]) throw new Error('Missing removal id');
        remote.enabled = false;
      } else if (command.args[1] !== '--verify-disabled' || remote.enabled)
        throw new Error('Remote access remains enabled');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command.args.at(-1) === 'puddle-connector.service') {
      const property = command.args.find((arg) => arg.startsWith('--property='))?.slice(11);
      const values: Record<string, string> = {
        Id: 'puddle-connector.service',
        LoadState: 'not-found',
        ActiveState: 'inactive',
        SubState: 'dead',
        MainPID: '0',
        NeedDaemonReload: 'no',
      };
      return {
        exitCode: 0,
        stdout: property!
          .split(',')
          .map((key) => `${key}=${values[key]}`)
          .join('\n'),
        stderr: '',
      };
    }
    const result = await f.run(command);
    if (remote.loseUnregisterReply && command.args[1] === 'daemon-reload')
      throw new Error('Lost unregistration reply');
    return result;
  };
  return {
    ...f,
    release: realpathSync(f.release),
    remote,
    remoteCalls,
    options: { ...f.options, platform: 'linux' as const, run },
  };
}
