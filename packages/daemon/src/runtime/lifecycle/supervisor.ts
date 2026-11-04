import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  runtimeRetiredSchema,
  runtimeSupervisorSchema,
  type RuntimeIdentity,
  type RuntimeSupervisor,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../compilation/process.js';
import { acquireRuntimeClaim, RuntimeClaimBusy } from '../ownership/claims.js';
import { readRuntimeJson, runtimeDirectory } from '../ownership/storage.js';

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unit = (value: string, expandEnvironment = false) =>
  '"' +
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, () => (expandEnvironment ? '$$' : '$')) +
  '"';

function validPath(value: string): void {
  // Unit/plist commands receive literal paths, never shell fragments or line breaks.
  // eslint-disable-next-line no-control-regex -- Host command boundary.
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Invalid runtime executable path');
}

interface LaunchOptions {
  kind: RuntimeSupervisor['kind'];
  nodePath: string;
  entryPath: string;
  uid?: number;
  run?: CompilationCommandRunner;
}

/** No restart policy or dependency on puddled: each owner has its own service lifetime. */
export function runtimeServiceDefinition(home: string, record: RuntimeSupervisor): string {
  validPath(home);
  validPath(record.node_path);
  validPath(record.entry_path);
  const args = [
    record.node_path,
    record.entry_path,
    '--home',
    home,
    '--runtime',
    record.identity.runtime_id,
  ];
  if (record.kind === 'systemd') {
    return `[Unit]\nDescription=Puddle runtime ${record.identity.runtime_id}\n[Service]\nType=simple\nExecStart=${args.map((arg) => unit(arg, true)).join(' ')}\nWorkingDirectory=${unit(home)}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=10\nUMask=0077\nStandardOutput=null\nStandardError=journal\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(record.name)}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(home)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><false/><key>Umask</key><integer>63</integer></dict></plist>\n`;
}

function writeDefinition(file: string, content: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function supervisorCommand(home: string, run: CompilationCommandRunner) {
  return async (file: string, args: string[]) => {
    const command = { file, args, cwd: home, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 };
    const result = await run(command);
    if (result.exitCode !== 0)
      throw new CompilationCommandError('Runtime supervisor command failed', command, result);
    return result;
  };
}

/**
 * Dispatch once. A repeated call only returns the recorded attempt, including
 * an uncertain one; readiness is established by authenticated runtime adoption.
 */
export async function startRuntimeService(
  home: string,
  identity: RuntimeIdentity,
  opts: LaunchOptions,
): Promise<RuntimeSupervisor> {
  const directory = runtimeDirectory(home, identity.runtime_id);
  validPath(home);
  validPath(opts.nodePath);
  validPath(opts.entryPath);
  // Resolve symlinks now: updates to current/default must not change this job's code.
  const nodePath = realpathSync(opts.nodePath);
  const entryPath = realpathSync(opts.entryPath);
  const hostKey = digest(realpathSync(home)).slice(0, 8);
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error('Runtime supervision requires a host user');
  const record = runtimeSupervisorSchema.parse({
    format: 1,
    identity,
    kind: opts.kind,
    name:
      opts.kind === 'systemd'
        ? `puddler-${hostKey}-${identity.runtime_id}.service`
        : `dev.puddle.runtime.${hostKey}.${identity.runtime_id}`,
    domain: opts.kind === 'launchd' ? `gui/${uid}` : null,
    node_path: nodePath,
    entry_path: entryPath,
    state: 'dispatching',
  });
  const claim = acquireRuntimeClaim(home, `runtime-dispatch:${identity.runtime_id}`);
  try {
    try {
      readRuntimeJson(join(directory, 'retired.json'));
      throw new Error('Runtime launch has been retired');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = join(directory, 'supervisor.json');
    try {
      const previous = runtimeSupervisorSchema.parse(readRuntimeJson(file));
      if (JSON.stringify({ ...previous, state: 'dispatching' }) !== JSON.stringify(record))
        throw new Error('Runtime supervisor attempt belongs to another launch');
      return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const definition = join(directory, record.kind === 'systemd' ? record.name : 'runtime.plist');
    writeDefinition(definition, runtimeServiceDefinition(home, record));
    // Persist before invoking the supervisor, so a lost reply never retries launch.
    atomicPrivateJson(file, record);
    const run = opts.run ?? runCompilationCommand;
    const execute = supervisorCommand(home, run);
    if (record.kind === 'systemd') {
      await execute('systemctl', ['--user', 'link', definition]);
      await execute('systemctl', ['--user', 'daemon-reload']);
      await execute('systemctl', ['--user', 'start', record.name]);
    } else {
      await execute('/bin/launchctl', ['bootstrap', record.domain!, definition]);
    }
    record.state = 'dispatched';
    atomicPrivateJson(file, record);
    return record;
  } finally {
    claim.release();
  }
}

/** Only collect an inactive owner. Runtime termination itself uses explicit control. */
export async function removeRuntimeService(
  home: string,
  identity: RuntimeIdentity,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<'removed' | 'absent' | 'owned'> {
  const directory = runtimeDirectory(home, identity.runtime_id);
  let claim: ReturnType<typeof acquireRuntimeClaim>;
  let launchClaim: ReturnType<typeof acquireRuntimeClaim> | undefined;
  let dispatchClaim: ReturnType<typeof acquireRuntimeClaim> | undefined;
  try {
    launchClaim = acquireRuntimeClaim(home, `runtime-launch:${identity.runtime_id}`);
    dispatchClaim = acquireRuntimeClaim(home, `runtime-dispatch:${identity.runtime_id}`);
    claim = acquireRuntimeClaim(home, `runtime:${identity.runtime_id}`);
  } catch (error) {
    dispatchClaim?.release();
    launchClaim?.release();
    if (error instanceof RuntimeClaimBusy) return 'owned';
    throw error;
  }
  try {
    const retire = () => {
      const file = join(directory, 'retired.json');
      try {
        const previous = runtimeRetiredSchema.parse(readRuntimeJson(file));
        if (JSON.stringify(previous.identity) !== JSON.stringify(identity))
          throw new Error('Runtime retirement identity mismatch');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        atomicPrivateJson(file, { format: 1, identity });
      }
    };
    const file = join(directory, 'supervisor.json');
    let record: RuntimeSupervisor;
    try {
      record = runtimeSupervisorSchema.parse(readRuntimeJson(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      retire();
      return 'absent';
    }
    if (JSON.stringify(record.identity) !== JSON.stringify(identity))
      throw new Error('Runtime supervisor identity mismatch');
    const hostKey = digest(realpathSync(home)).slice(0, 8);
    const expectedName =
      record.kind === 'systemd'
        ? `puddler-${hostKey}-${identity.runtime_id}.service`
        : `dev.puddle.runtime.${hostKey}.${identity.runtime_id}`;
    if (record.name !== expectedName || (record.kind === 'launchd' && record.domain === null))
      throw new Error('Runtime supervisor target mismatch');
    if (record.state === 'removed') return 'removed';
    // Fence a queued service start before releasing this lock after unregistering.
    retire();
    const execute = supervisorCommand(home, run);
    const result = async (command: string, args: string[]) => {
      try {
        return await execute(command, args);
      } catch (error) {
        if (error instanceof CompilationCommandError && error.result) return error.result;
        throw error;
      }
    };
    if (record.kind === 'systemd') {
      const absent = async () => {
        const observed = await result('systemctl', [
          '--user',
          'show',
          '--property=LoadState,ActiveState,SubState',
          record.name,
        ]);
        const values = new Map(
          observed.stdout
            .trim()
            .split('\n')
            .map((line) => {
              const [key, value] = line.split('=');
              return [key, value] as const;
            }),
        );
        return (
          [0, 4].includes(observed.exitCode) &&
          values.get('LoadState') === 'not-found' &&
          values.get('ActiveState') === 'inactive' &&
          values.get('SubState') === 'dead'
        );
      };
      try {
        await execute('systemctl', ['--user', 'stop', record.name]);
      } catch (error) {
        if (!(await absent())) throw error;
      }
      try {
        await execute('systemctl', ['--user', 'disable', record.name]);
      } catch (error) {
        await execute('systemctl', ['--user', 'daemon-reload']);
        if (!(await absent())) throw error;
      }
      await execute('systemctl', ['--user', 'daemon-reload']);
    } else {
      const target = `${record.domain!}/${record.name}`;
      const absent = async () => {
        const observed = await result('/bin/launchctl', ['print', target]);
        // launchctl error 113: service not found. Other errors never establish absence.
        if (observed.exitCode !== 0 && observed.exitCode !== 113)
          throw new Error('Could not inspect runtime service registration');
        return observed.exitCode === 113;
      };
      if (!(await absent())) {
        try {
          await execute('/bin/launchctl', ['bootout', target]);
        } catch (error) {
          if (!(await absent())) throw error;
        }
      }
    }
    atomicPrivateJson(file, { ...record, state: 'removed' });
    return 'removed';
  } finally {
    claim.release();
    dispatchClaim.release();
    launchClaim.release();
  }
}
