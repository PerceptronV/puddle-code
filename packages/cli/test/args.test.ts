import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
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
