import { CliError } from '../lib/types.js';

export type Command =
  | {
      cmd: 'start';
      port?: number;
      noBrowser: boolean;
      noUpgrade: boolean;
      tarball?: string;
      foreground: boolean;
    }
  | {
      cmd: 'connect';
      host: string;
      port?: number;
      remotePort?: number;
      noBrowser: boolean;
      noUpgrade: boolean;
      tarball?: string;
      foreground: boolean;
    }
  | { cmd: 'list' }
  | { cmd: 'kill'; target?: string; all: boolean }
  | { cmd: 'status'; host?: string }
  | { cmd: 'attach'; host?: string; session: string; term?: string }
  | { cmd: 'logs'; host?: string; session?: string; term?: string; follow: boolean }
  | { cmd: 'upgrade'; host?: string }
  | { cmd: 'help' }
  | { cmd: 'version' };

export const USAGE = `puddle — self-hosted orchestrator for CLI coding agents

usage:
  puddle start   [--port <p>] [--foreground] [--no-browser] [--no-upgrade]
                 [--tarball <path>]
  puddle connect user@host [--port <local>] [--remote-port <p>] [--foreground]
                 [--no-browser] [--no-upgrade] [--tarball <path>]
  puddle list
  puddle kill    [local | user@host | --all]
  puddle status  [user@host]
  puddle attach  [user@host] <session> [--term <id>]
  puddle logs    [user@host] [session] [--term <id>] [-f|--follow]
  puddle upgrade [user@host]
  puddle --version | --help

start serves the cockpit at http://localhost:7433 against the daemon on this
machine (installing it under ~/.puddle if needed); connect does the same for
an SSH host through one tunnel. Both keep running in the background once
ready, so the terminal may close (--foreground to stay attached; Ctrl-C then
stops the cockpit). list shows running cockpits; kill stops one — sessions
keep running on the host either way.`;

/** Hand-rolled argv parser — the surface is small enough to own outright. */
export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h')
    return { cmd: 'help' };
  if (cmd === '--version' || cmd === '-v') return { cmd: 'version' };

  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg.startsWith('-')) {
      const valued = new Set(['--port', '--remote-port', '--tarball', '--term']);
      if (valued.has(arg)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new CliError('bad_arguments', `${arg} needs a value`);
        }
        flags.set(arg, value);
        i += 1;
      } else {
        flags.set(arg, true);
      }
    } else {
      positionals.push(arg);
    }
  }

  const intFlag = (name: string): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new CliError('bad_arguments', `${name} must be an integer between 1 and 65535`);
    }
    return value;
  };
  const strFlag = (name: string): string | undefined => {
    const raw = flags.get(name);
    return typeof raw === 'string' ? raw : undefined;
  };
  const used = new Set<string>();
  const expect = (...names: string[]) => {
    names.forEach((n) => used.add(n));
    for (const key of flags.keys()) {
      if (!used.has(key)) throw new CliError('bad_arguments', `unknown flag ${key} for '${cmd}'`);
    }
  };

  switch (cmd) {
    case 'start': {
      if (positionals.length > 0) {
        throw new CliError(
          'bad_arguments',
          `start takes no positional arguments (got '${positionals[0]}')`,
        );
      }
      const port = intFlag('--port');
      const tarball = strFlag('--tarball');
      expect('--port', '--no-browser', '--no-upgrade', '--tarball', '--foreground');
      return {
        cmd: 'start',
        ...(port !== undefined ? { port } : {}),
        ...(tarball !== undefined ? { tarball } : {}),
        noBrowser: flags.has('--no-browser'),
        noUpgrade: flags.has('--no-upgrade'),
        foreground: flags.has('--foreground'),
      };
    }
    case 'connect': {
      const host = positionals[0];
      if (host === undefined)
        throw new CliError('bad_arguments', 'connect needs a host: puddle connect user@host');
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'connect takes exactly one host');
      const port = intFlag('--port');
      const remotePort = intFlag('--remote-port');
      const tarball = strFlag('--tarball');
      expect(
        '--port',
        '--remote-port',
        '--no-browser',
        '--no-upgrade',
        '--tarball',
        '--foreground',
      );
      return {
        cmd: 'connect',
        host,
        ...(port !== undefined ? { port } : {}),
        ...(remotePort !== undefined ? { remotePort } : {}),
        ...(tarball !== undefined ? { tarball } : {}),
        noBrowser: flags.has('--no-browser'),
        noUpgrade: flags.has('--no-upgrade'),
        foreground: flags.has('--foreground'),
      };
    }
    case 'list': {
      if (positionals.length > 0)
        throw new CliError('bad_arguments', 'list takes no positional arguments');
      expect();
      return { cmd: 'list' };
    }
    case 'kill': {
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'kill takes at most one target');
      expect('--all');
      const all = flags.has('--all');
      const target = positionals[0];
      if (all && target !== undefined)
        throw new CliError('bad_arguments', 'kill takes a target or --all, not both');
      return { cmd: 'kill', all, ...(target !== undefined ? { target } : {}) };
    }
    case 'status': {
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'status takes at most a host');
      expect();
      const host = positionals[0];
      return { cmd: 'status', ...(host !== undefined ? { host } : {}) };
    }
    case 'attach': {
      // Two positionals → host + session; one → session on the local daemon.
      const [first, second, extra] = positionals;
      if (first === undefined) {
        throw new CliError(
          'bad_arguments',
          'attach needs a session: puddle attach [user@host] <session>',
        );
      }
      if (extra !== undefined)
        throw new CliError('bad_arguments', 'attach takes at most host + session');
      const term = strFlag('--term');
      expect('--term');
      return second === undefined
        ? { cmd: 'attach', session: first, ...(term !== undefined ? { term } : {}) }
        : { cmd: 'attach', host: first, session: second, ...(term !== undefined ? { term } : {}) };
    }
    case 'logs': {
      const [first, second, extra] = positionals;
      if (extra !== undefined)
        throw new CliError('bad_arguments', 'logs takes at most host + session');
      const term = strFlag('--term');
      expect('--term', '-f', '--follow');
      const follow = flags.has('-f') || flags.has('--follow');
      // Disambiguate one positional: user@host is a host, anything else a session.
      if (second !== undefined) {
        return {
          cmd: 'logs',
          host: first as string,
          session: second,
          follow,
          ...(term !== undefined ? { term } : {}),
        };
      }
      if (first === undefined)
        return { cmd: 'logs', follow, ...(term !== undefined ? { term } : {}) };
      return first.includes('@')
        ? { cmd: 'logs', host: first, follow, ...(term !== undefined ? { term } : {}) }
        : { cmd: 'logs', session: first, follow, ...(term !== undefined ? { term } : {}) };
    }
    case 'upgrade': {
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'upgrade takes at most a host');
      expect();
      const host = positionals[0];
      return { cmd: 'upgrade', ...(host !== undefined ? { host } : {}) };
    }
    default:
      throw new CliError('bad_arguments', `unknown command '${cmd}'`, 'see: puddle --help');
  }
}
