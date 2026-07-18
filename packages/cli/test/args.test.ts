import { describe, expect, it } from 'vitest';
import { argvFor, parseArgs } from '../src/cli/args.js';
import { CliError } from '../src/lib/types.js';

describe('argument parsing', () => {
  it('parses start with flags', () => {
    expect(parseArgs(['start', '--port', '7500', '--no-browser', '--tarball', 'x.tar.gz'])).toEqual(
      {
        cmd: 'start',
        port: 7500,
        tarball: 'x.tar.gz',
        noBrowser: true,
        noUpgrade: false,
        foreground: false,
      },
    );
  });

  it('parses connect with a host', () => {
    expect(parseArgs(['connect', 'alice@devbox', '--remote-port', '7500', '--no-upgrade'])).toEqual(
      {
        cmd: 'connect',
        host: 'alice@devbox',
        remotePort: 7500,
        noBrowser: false,
        noUpgrade: true,
        foreground: false,
      },
    );
  });

  it('parses --foreground on start and connect', () => {
    expect(parseArgs(['start', '--foreground'])).toMatchObject({ cmd: 'start', foreground: true });
    expect(parseArgs(['connect', 'a@b', '--foreground'])).toMatchObject({
      cmd: 'connect',
      foreground: true,
    });
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

  it('parses --prefer-port on start and connect (non-strict UI port for refresh)', () => {
    expect(parseArgs(['start', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'start',
      preferPort: 7435,
    });
    expect(parseArgs(['connect', 'a@b', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'connect',
      preferPort: 7435,
    });
  });

  it('argvFor is the inverse of parseArgs for start/connect', () => {
    const start = parseArgs([
      'start',
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
    if (start.cmd !== 'start') throw new Error('expected start');
    expect(parseArgs(argvFor(start))).toEqual(start);

    const connect = parseArgs(['connect', 'alice@devbox', '--remote-port', '7500']);
    if (connect.cmd !== 'connect') throw new Error('expected connect');
    expect(parseArgs(argvFor(connect))).toEqual(connect);
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

  it('rejects connect without a host and unknown flags', () => {
    expect(() => parseArgs(['connect'])).toThrow(CliError);
    expect(() => parseArgs(['start', '--frobnicate'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['nonsense'])).toThrow(/unknown command/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseArgs(['start', '--port', '99999'])).toThrow(/between 1 and 65535/);
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

  it('help and version', () => {
    expect(parseArgs([])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--version'])).toEqual({ cmd: 'version' });
  });
});
