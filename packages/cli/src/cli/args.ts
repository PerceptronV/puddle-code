import { CliError } from '../lib/types.js';

export type Command =
  | {
      cmd: 'launch';
      /** 'local' or user@host — the parser normalises "no argument" to 'local'. */
      target: string;
      port?: number;
      /**
       * Start the UI-port probe here without insisting on it (unlike --port,
       * which is strict). `refresh` uses this to land the new cockpit back on
       * the old origin so an open browser tab survives the swap.
       */
      preferPort?: number;
      /** Daemon port on the remote host; meaningless (and rejected) locally. */
      remotePort?: number;
      noBrowser: boolean;
      noUpgrade: boolean;
      tarball?: string;
      foreground: boolean;
    }
  | {
      cmd: 'refresh';
      /** 'local' or user@host; omitted → the sole running cockpit. */
      target?: string;
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
  | { cmd: 'upgrade'; what: 'cli' | 'daemon' | 'desktop'; host?: string }
  | { cmd: 'help' }
  | { cmd: 'version' };

export const USAGE = `puddle — self-hosted orchestrator for CLI coding agents

usage:
  puddle launch  [local | user@host] [--port <p>] [--remote-port <p>]
                 [--foreground] [--no-browser] [--no-upgrade] [--tarball <path>]
  puddle refresh [local | user@host] [--port <p>] [--remote-port <p>]
                 [--foreground] [--no-browser] [--no-upgrade] [--tarball <path>]
  puddle list
  puddle kill    [local | user@host | --all]
  puddle status  [user@host]
  puddle attach  [user@host] <session> [--term <id>]
  puddle logs    [user@host] [session] [--term <id>] [-f|--follow]
  puddle upgrade <cli | daemon | desktop> [user@host]
  puddle --version | --help

launch serves the cockpit at http://localhost:7433 against the daemon on this
machine when no host (or 'local') is given — installing it under ~/.puddle if
needed — and does the same for an SSH host through one tunnel. It keeps
running in the background once ready, so the terminal may close (--foreground
to stay attached; Ctrl-C then stops the cockpit). refresh stops a target's
cockpit (even a wedged one) and runs the full launch flow again — tunnel,
daemon restart if needed — keeping the old UI port so open tabs survive.
list shows running cockpits; kill stops one — sessions keep running on the
host either way.`;

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
      const valued = new Set(['--port', '--prefer-port', '--remote-port', '--tarball', '--term']);
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
    case 'launch': {
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'launch takes at most one target');
      const target = positionals[0] ?? 'local';
      const port = intFlag('--port');
      const preferPort = intFlag('--prefer-port');
      const remotePort = intFlag('--remote-port');
      const tarball = strFlag('--tarball');
      expect(
        '--port',
        '--prefer-port',
        '--remote-port',
        '--no-browser',
        '--no-upgrade',
        '--tarball',
        '--foreground',
      );
      if (target === 'local' && remotePort !== undefined) {
        throw new CliError('bad_arguments', '--remote-port only applies to an SSH target');
      }
      return {
        cmd: 'launch',
        target,
        ...(port !== undefined ? { port } : {}),
        ...(preferPort !== undefined ? { preferPort } : {}),
        ...(remotePort !== undefined ? { remotePort } : {}),
        ...(tarball !== undefined ? { tarball } : {}),
        noBrowser: flags.has('--no-browser'),
        noUpgrade: flags.has('--no-upgrade'),
        foreground: flags.has('--foreground'),
      };
    }
    // The pre-unification verbs, kept only to say what replaced them.
    case 'start':
      throw new CliError('bad_arguments', `'start' is now: puddle launch`);
    case 'connect':
      throw new CliError(
        'bad_arguments',
        `'connect' is now: puddle launch ${positionals[0] ?? 'user@host'}`,
      );
    case 'refresh': {
      if (positionals.length > 1)
        throw new CliError('bad_arguments', 'refresh takes at most one target');
      const target = positionals[0];
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
        cmd: 'refresh',
        ...(target !== undefined ? { target } : {}),
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
      const [what, host, extra] = positionals;
      if (what !== 'cli' && what !== 'daemon' && what !== 'desktop') {
        throw new CliError(
          'bad_arguments',
          'upgrade needs a subject: puddle upgrade <cli | daemon | desktop> [user@host]',
          what !== undefined && what.includes('@')
            ? `to upgrade the daemon on ${what}: puddle upgrade daemon ${what}`
            : undefined,
        );
      }
      if (extra !== undefined)
        throw new CliError('bad_arguments', 'upgrade takes at most a subject + host');
      expect();
      return { cmd: 'upgrade', what, ...(host !== undefined ? { host } : {}) };
    }
    default:
      throw new CliError('bad_arguments', `unknown command '${cmd}'`, 'see: puddle --help');
  }
}

/**
 * The argv that parses back to this launch command — what a detached re-exec
 * runs when the launching command was NOT launch itself (`refresh` kills the
 * old cockpit, then detaches the rebuilt command). Kept next to `parseArgs`
 * so the two stay inverse of each other.
 */
export function argvFor(command: Extract<Command, { cmd: 'launch' }>): string[] {
  const argv: string[] = ['launch'];
  if (command.target !== 'local') argv.push(command.target);
  if (command.port !== undefined) argv.push('--port', String(command.port));
  if (command.preferPort !== undefined) argv.push('--prefer-port', String(command.preferPort));
  if (command.remotePort !== undefined) argv.push('--remote-port', String(command.remotePort));
  if (command.tarball !== undefined) argv.push('--tarball', command.tarball);
  if (command.noBrowser) argv.push('--no-browser');
  if (command.noUpgrade) argv.push('--no-upgrade');
  if (command.foreground) argv.push('--foreground');
  return argv;
}
