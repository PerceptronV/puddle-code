import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../src/compilation/process.js';
import { HostRemovalGuard } from '../../src/host/removal/guard.js';
import type { ServiceTarget } from '../../src/host/supervision/target.js';

export function removalServiceFixture(kind: ServiceTarget['kind'], running = true) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-remove-service-'));
  const target: ServiceTarget = {
    kind,
    name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
    domain: kind === 'systemd' ? null : `gui/${process.getuid!()}`,
  };
  const file =
    kind === 'systemd'
      ? join(home, '.config/systemd/user', target.name)
      : join(home, 'Library/LaunchAgents', `${target.name}.plist`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, 'reviewed definition', { mode: 0o600 });
  const guard = HostRemovalGuard.acquire(home);
  const commands: CompilationCommand[] = [];
  // Only signal zero is ever used; this synthetic PID cannot name a fixture process.
  const pid = 2_000_000_000;
  const state = {
    running,
    registered: true,
    failed: false,
    fragment: file,
    component: 'daemon' as 'daemon' | 'connector',
  };
  const run: CompilationCommandRunner = async (command) => {
    commands.push(command);
    let stdout = '';
    let exitCode = 0;
    const verb = kind === 'systemd' ? command.args[1] : command.args[0];
    if (command.file === '/usr/bin/plutil')
      stdout = JSON.stringify({
        Label: target.name,
        ProgramArguments:
          state.component === 'daemon'
            ? [join(home, 'bin/current/puddled')]
            : [join(home, 'bin/current/bin/node'), join(home, 'bin/current/daemon/connector.mjs')],
      });
    else if (kind === 'systemd') {
      if (verb === 'cat') stdout = `# ${state.fragment}\n${readFileSync(file, 'utf8')}`;
      if (verb === 'stop') state.running = false;
      if (verb === 'reset-failed') state.failed = false;
      if (verb === 'daemon-reload') state.registered = existsSync(file);
      const property = command.args.find((arg) => arg.startsWith('--property='))?.slice(11);
      if (property === 'FragmentPath') stdout = state.fragment;
      else if (property === 'ExecStart')
        stdout = `{ path=${join(home, 'bin/current/puddled')} ; argv[]=${join(home, 'bin/current/puddled')} }`;
      else if (property) {
        const values: Record<string, string> = {
          Id: target.name,
          LoadState: state.registered ? 'loaded' : 'not-found',
          ActiveState: state.running ? 'active' : state.failed ? 'failed' : 'inactive',
          SubState: state.running ? 'running' : state.failed ? 'failed' : 'dead',
          MainPID: state.running ? String(pid) : '0',
          NeedDaemonReload: 'no',
          InvocationID: 'a'.repeat(32),
          ControlGroup: `/${target.name}`,
          CanStart: 'yes',
          CanStop: 'yes',
        };
        stdout = property
          .split(',')
          .map((key) => `${key}=${values[key] ?? ''}`)
          .join('\n');
      }
    } else {
      if (verb === 'managername') stdout = 'Aqua';
      if (verb === 'manageruid') stdout = String(process.getuid!());
      if (verb === 'list') stdout = `${state.running ? pid : '-'} 0 ${target.name}\n`;
      if (verb === 'print') exitCode = state.registered ? 0 : 113;
      if (verb === 'bootout') {
        state.running = false;
        state.registered = false;
      }
    }
    return { exitCode, stdout, stderr: '' };
  };
  return {
    home,
    target,
    file,
    guard,
    pid,
    state,
    commands,
    run,
    close() {
      guard.release();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
