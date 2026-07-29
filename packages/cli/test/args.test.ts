import { describe, expect, it } from 'vitest';
import { argvFor, parseArgs } from '../src/cli/args.js';
import { CliError } from '../src/lib/types.js';

describe('argument parsing', () => {
  it('parses launch: bare and local mean local, a host means SSH', () => {
    expect(
      parseArgs(['launch', '--port', '7500', '--no-browser', '--tarball', 'x.tar.gz']),
    ).toEqual({
      cmd: 'launch',
      target: 'local',
      port: 7500,
      tarball: 'x.tar.gz',
      noBrowser: true,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['launch', 'local'])).toMatchObject({ cmd: 'launch', target: 'local' });
    expect(parseArgs(['launch', 'alice@devbox', '--remote-port', '7500', '--no-upgrade'])).toEqual({
      cmd: 'launch',
      target: 'alice@devbox',
      remotePort: 7500,
      noBrowser: false,
      noUpgrade: true,
      foreground: false,
    });
    expect(parseArgs(['launch', '--foreground'])).toMatchObject({
      cmd: 'launch',
      foreground: true,
    });
    expect(() => parseArgs(['launch', 'a@b', 'c@d'])).toThrow(/at most one target/);
    expect(() => parseArgs(['launch', '--remote-port', '7500'])).toThrow(/SSH target/);
  });

  it('start and connect say what replaced them', () => {
    expect(() => parseArgs(['start'])).toThrow(/puddle launch/);
    expect(() => parseArgs(['connect', 'a@b'])).toThrow(/puddle launch a@b/);
  });

  it('parses refresh: bare, with a target, and with pass-through flags', () => {
    expect(parseArgs(['refresh'])).toEqual({
      cmd: 'refresh',
      noBrowser: false,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['refresh', 'alice@devbox', '--no-browser'])).toEqual({
      cmd: 'refresh',
      target: 'alice@devbox',
      noBrowser: true,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['refresh', 'local', '--port', '7500', '--tarball', 'x.tar.gz'])).toEqual({
      cmd: 'refresh',
      target: 'local',
      port: 7500,
      tarball: 'x.tar.gz',
      noBrowser: false,
      noUpgrade: false,
      foreground: false,
    });
    expect(() => parseArgs(['refresh', 'a@b', 'c@d'])).toThrow(/at most one target/);
  });

  it('parses --prefer-port on launch (non-strict UI port for refresh)', () => {
    expect(parseArgs(['launch', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'launch',
      preferPort: 7435,
    });
    expect(parseArgs(['launch', 'a@b', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'launch',
      target: 'a@b',
      preferPort: 7435,
    });
  });

  it('argvFor is the inverse of parseArgs for launch', () => {
    const local = parseArgs([
      'launch',
      '--port',
      '7500',
      '--prefer-port',
      '7435',
      '--tarball',
      'x.tar.gz',
      '--no-browser',
      '--no-upgrade',
      '--foreground',
    ]);
    if (local.cmd !== 'launch') throw new Error('expected launch');
    expect(parseArgs(argvFor(local))).toEqual(local);

    const remote = parseArgs(['launch', 'alice@devbox', '--remote-port', '7500']);
    if (remote.cmd !== 'launch') throw new Error('expected launch');
    expect(parseArgs(argvFor(remote))).toEqual(remote);
  });

  it('parses list and kill', () => {
    expect(parseArgs(['list'])).toEqual({ cmd: 'list' });
    expect(parseArgs(['kill'])).toEqual({ cmd: 'kill', all: false });
    expect(parseArgs(['kill', 'alice@devbox'])).toEqual({
      cmd: 'kill',
      target: 'alice@devbox',
      all: false,
    });
    expect(parseArgs(['kill', '--all'])).toEqual({ cmd: 'kill', all: true });
    expect(() => parseArgs(['kill', 'a@b', '--all'])).toThrow(/not both/);
    expect(() => parseArgs(['list', 'extra'])).toThrow(CliError);
  });

  it('rejects unknown flags and commands', () => {
    expect(() => parseArgs(['launch', '--frobnicate'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['nonsense'])).toThrow(/unknown command/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseArgs(['launch', '--port', '99999'])).toThrow(/between 1 and 65535/);
  });

  it('attach: one positional is a session, two are host + session', () => {
    expect(parseArgs(['attach', 'abc123'])).toEqual({ cmd: 'attach', session: 'abc123' });
    expect(parseArgs(['attach', 'user@host', 'abc123', '--term', 'shell-1'])).toEqual({
      cmd: 'attach',
      host: 'user@host',
      session: 'abc123',
      term: 'shell-1',
    });
  });

  it('logs: a lone user@host positional is a host, anything else a session', () => {
    expect(parseArgs(['logs', 'user@host', '-f'])).toEqual({
      cmd: 'logs',
      host: 'user@host',
      follow: true,
    });
    expect(parseArgs(['logs', 'abc123'])).toEqual({
      cmd: 'logs',
      session: 'abc123',
      follow: false,
    });
    expect(parseArgs(['logs'])).toEqual({ cmd: 'logs', follow: false });
  });

  it('upgrade: a required subject, then an optional host', () => {
    expect(parseArgs(['upgrade', 'daemon'])).toEqual({ cmd: 'upgrade', what: 'daemon' });
    expect(parseArgs(['upgrade', 'daemon', 'user@host'])).toEqual({
      cmd: 'upgrade',
      what: 'daemon',
      host: 'user@host',
    });
    expect(parseArgs(['upgrade', 'cli'])).toEqual({ cmd: 'upgrade', what: 'cli' });
    expect(parseArgs(['upgrade', 'desktop'])).toEqual({ cmd: 'upgrade', what: 'desktop' });
    expect(() => parseArgs(['upgrade'])).toThrow(CliError);
    // The pre-split form (`puddle upgrade user@host`) gets a pointed hint.
    try {
      parseArgs(['upgrade', 'user@host']);
      expect.unreachable('a bare host must not parse');
    } catch (e) {
      expect((e as CliError).hint).toContain('upgrade daemon user@host');
    }
  });

  it('help and version', () => {
    expect(parseArgs([])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--version'])).toEqual({ cmd: 'version' });
  });
});
