import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  CompilationCommandError,
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../compilation/process.js';

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

export function validServicePath(value: string): void {
  // eslint-disable-next-line no-control-regex -- Literal supervisor command boundary.
  if (!isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Invalid service executable path');
}

/** Independent user services never inherit puddled's restart/termination policy. */
export function independentServiceDefinition(options: {
  home: string;
  kind: 'systemd' | 'launchd';
  name: string;
  description: string;
  args: string[];
  timeoutSeconds?: number;
}): string {
  const { home, kind, name, description, args } = options;
  validServicePath(home);
  validServicePath(args[0] ?? '');
  // eslint-disable-next-line no-control-regex -- Unit/plist fields must remain single values.
  if ([name, description, ...args].some((value) => /[\u0000-\u001f\u007f]/.test(value)))
    throw new Error('Invalid service argument');
  const timeout = options.timeoutSeconds;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600))
    throw new Error('Invalid service lifetime');
  if (kind === 'systemd') {
    // WorkingDirectory is a literal path with specifier expansion, not an
    // ExecStart word: quotes become part of the path and make it non-absolute.
    // The /. suffix preserves a final space or backslash through INI parsing.
    const directory = `${home.replace(/%/g, '%%')}/.`;
    return `[Unit]\nDescription=${description}\n[Service]\nType=simple\nExecStart=${args.map((arg) => unit(arg, true)).join(' ')}\nWorkingDirectory=${directory}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=10\n${timeout === undefined ? '' : `RuntimeMaxSec=${timeout}\n`}UMask=0077\nStandardOutput=null\nStandardError=journal\n`;
  }
  // launchd has no per-job running-time limit; bounded workers enforce theirs internally.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(name)}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(home)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><false/><key>Umask</key><integer>63</integer></dict></plist>\n`;
}

export function writeServiceDefinition(file: string, content: string | Uint8Array): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function supervisorCommand(
  home: string,
  run: CompilationCommandRunner = runCompilationCommand,
) {
  return async (file: string, args: string[]) => {
    const command = { file, args, cwd: home, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 };
    const result = await run(command);
    if (result.exitCode !== 0)
      throw new CompilationCommandError('Host supervisor command failed', command, result);
    return result;
  };
}

/** The caller must durably consume its dispatch before entering this function. */
export async function dispatchService(
  home: string,
  service: { kind: 'systemd' | 'launchd'; name: string; domain: string | null },
  definition: string,
  run?: CompilationCommandRunner,
): Promise<void> {
  const execute = supervisorCommand(home, run);
  if (service.kind === 'systemd') {
    await execute('systemctl', ['--user', 'link', definition]);
    await execute('systemctl', ['--user', 'daemon-reload']);
    await execute('systemctl', ['--user', 'start', service.name]);
  } else {
    if (!service.domain) throw new Error('Missing launchd domain');
    await execute('/bin/launchctl', ['bootstrap', service.domain, definition]);
  }
}
