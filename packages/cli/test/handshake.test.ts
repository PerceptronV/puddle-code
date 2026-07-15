import { describe, expect, it } from 'vitest';
import type { VersionResponse } from '@puddle/shared';
import { PROTOCOL_VERSION } from '@puddle/shared';
import type { DaemonClient } from '../src/lib/daemon-client.js';
import { CLI_UPGRADE_COMMAND, decideHandshake, runHandshake } from '../src/lib/handshake.js';
import { CliError } from '../src/lib/types.js';

const CLI = { major: 5 };

describe('decideHandshake', () => {
  it('same major proceeds (app-version skew is silent)', () => {
    expect(decideHandshake(CLI, { major: 5 })).toEqual({ kind: 'proceed' });
  });
  it('older daemon major upgrades', () => {
    expect(decideHandshake(CLI, { major: 4 })).toEqual({ kind: 'upgrade-daemon' });
  });
  it('newer daemon major refuses with the CLI upgrade command', () => {
    expect(decideHandshake(CLI, { major: 6 })).toEqual({
      kind: 'refuse-cli-outdated',
      command: CLI_UPGRADE_COMMAND,
    });
  });
});

function stubClient(versions: VersionResponse[], live = 0): DaemonClient {
  let call = 0;
  return {
    version: () => Promise.resolve(versions[Math.min(call++, versions.length - 1)]),
    liveSessionCount: () => Promise.resolve(live),
  } as unknown as DaemonClient;
}

const v = (major: number, version = '1.0.0'): VersionResponse => ({
  version,
  protocol: { major, minor: 0 },
});

describe('runHandshake', () => {
  it('proceeds on a matching major without touching the upgrader', async () => {
    let upgraded = false;
    const result = await runHandshake({
      client: stubClient([v(PROTOCOL_VERSION.major)]),
      upgradeDaemon: async () => {
        upgraded = true;
      },
    });
    expect(result.protocol.major).toBe(PROTOCOL_VERSION.major);
    expect(upgraded).toBe(false);
  });

  it('upgrades an older daemon and re-verifies', async () => {
    const seen: number[] = [];
    const result = await runHandshake({
      client: stubClient(
        [v(PROTOCOL_VERSION.major - 1, '0.9.0'), v(PROTOCOL_VERSION.major, '1.0.0')],
        3,
      ),
      upgradeDaemon: async (info) => {
        seen.push(info.liveSessions);
      },
    });
    expect(seen).toEqual([3]);
    expect(result.version).toBe('1.0.0');
  });

  it('aborts on --no-upgrade with the live-session count in the hint', async () => {
    await expect(
      runHandshake({
        client: stubClient([v(PROTOCOL_VERSION.major - 1)], 2),
        noUpgrade: true,
        upgradeDaemon: async () => {},
      }),
    ).rejects.toMatchObject({
      code: 'upgrade_failed',
      hint: expect.stringContaining('2 live session(s)'),
    });
  });

  it('fails when the daemon still mismatches after the upgrade', async () => {
    await expect(
      runHandshake({
        client: stubClient([v(PROTOCOL_VERSION.major - 1), v(PROTOCOL_VERSION.major - 1)]),
        upgradeDaemon: async () => {},
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof CliError && e.code === 'upgrade_failed');
  });

  it('refuses a newer daemon with the exact CLI upgrade command', async () => {
    await expect(
      runHandshake({
        client: stubClient([v(PROTOCOL_VERSION.major + 1)]),
        upgradeDaemon: async () => {},
      }),
    ).rejects.toMatchObject({
      code: 'cli_outdated',
      hint: expect.stringContaining(CLI_UPGRADE_COMMAND),
    });
  });
});
