import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, PROTOCOL_VERSION, type HostRemovalStatus } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { startHostControl } from '../../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../../daemon/src/security/leases.js';
import { restoreInstalledDaemon } from '../../../src/lib/installation/host/restore.js';
import type { Transport } from '../../../src/lib/transport/transport.js';
import { runInstall } from '../../../src/cli/manage.js';

const cli = vi.hoisted(() => ({ transport: null as Transport | null, upgrade: vi.fn() }));
vi.mock('../../../src/lib/transport/open.js', () => ({
  openHostTransport: async () => cli.transport,
}));
vi.mock('../../../src/lib/installation/upgrade.js', () => ({ upgradeDaemon: cli.upgrade }));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  cli.upgrade.mockReset();
});

function fixture(kind: 'local' | 'ssh' = 'local') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-restore-cli-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv('PUDDLE_HOME', home);
  const registry = new LeaseRegistry();
  cleanups.push(() => registry.dispose());
  const id = randomUUID();
  const state = {
    status: { state: 'removed', id } as HostRemovalStatus,
    outcome: 'ready' as 'ready' | 'lost-reply' | 'refused' | 'changed',
    capabilities: hostReleaseCapabilities('0.4.37'),
    legacy: false,
    active: false,
    malformed: false,
  };
  const commands: string[] = [];
  const ready = async () => {
    cleanups.push(
      await startHostControl(home, registry, () => ({
        port: 7434,
        version: { version: '0.4.37', protocol: PROTOCOL_VERSION },
      })),
    );
  };
  const transport: Transport = {
    kind,
    label: 'isolated fixture',
    async exec(command, options) {
      commands.push(command);
      if (command.includes('/VERSION')) return { code: 0, stdout: '0.4.37\n', stderr: '' };
      if (command.includes('/bin/node -e ') && options?.stdin)
        return { code: 0, stdout: '', stderr: '' }; // Existing SSH control-helper staging.
      if (command.includes('HOST_CAPABILITIES.json'))
        return {
          code: state.legacy ? 3 : 0,
          stdout: JSON.stringify(state.capabilities),
          stderr: '',
        };
      if (command.includes('services.json'))
        return { code: state.active ? 0 : 3, stdout: '', stderr: '' };
      if (command.includes('--inspect-removal'))
        return {
          code: 0,
          stdout: state.malformed ? '{' : JSON.stringify(state.status),
          stderr: '',
        };
      if (command.includes('--restore-services')) {
        if (state.outcome === 'refused') return { code: 1, stdout: '', stderr: 'private details' };
        state.status = { state: 'restored', id: state.outcome === 'changed' ? randomUUID() : id };
        if (state.outcome === 'lost-reply') throw new Error('Lost reply');
      } else if (command.includes('--start-daemon')) await ready();
      else throw new Error('Unexpected command');
      return { code: 0, stdout: '', stderr: '' };
    },
    openChannel: () => connect(ipcPath(home, 'host')),
    async readFile() {
      throw new Error('No private file export');
    },
    async copyTo() {
      throw new Error('No release download');
    },
    dispose() {},
  };
  return { transport, state, id, commands, ready };
}

it.each(['local', 'ssh'] as const)(
  'restores %s configuration before existing authenticated startup',
  async (kind) => {
    const f = fixture(kind);
    expect(await restoreInstalledDaemon(f.transport)).toBe(true);
    expect(f.commands.filter((command) => command.includes('--restore-services'))).toHaveLength(1);
    expect(f.commands.filter((command) => command.includes('--start-daemon'))).toHaveLength(1);
    const before = [...f.commands];
    expect(await restoreInstalledDaemon(f.transport)).toBe(true);
    expect(
      f.commands
        .slice(before.length)
        .some((command) => /--restore-services|--start-daemon/.test(command)),
    ).toBe(false);
  },
);

it('observes an exact completed hand-off after losing the restoration reply', async () => {
  const f = fixture('ssh');
  f.state.outcome = 'lost-reply';
  expect(await restoreInstalledDaemon(f.transport)).toBe(true);
  expect(f.commands.filter((command) => command.includes('--restore-services'))).toHaveLength(1);
});

it.each([undefined, '0.4.37'])(
  'public install at %s restores before the already-installed shortcut without downloading a release',
  async (version) => {
    const f = fixture();
    cli.transport = f.transport;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await runInstall({ cmd: 'install', what: 'daemon', version }, logger)).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('v0.4.37 is ready'));
    expect(cli.upgrade).not.toHaveBeenCalled();
    expect(f.commands.findIndex((command) => command.includes('--restore-services'))).toBeLessThan(
      f.commands.findIndex((command) => command.includes('/VERSION')),
    );
  },
);

it('public install at another release restores first and then uses the existing update coordinator', async () => {
  const f = fixture();
  cli.transport = f.transport;
  cli.upgrade.mockImplementation(async () => {
    expect(f.state.status.state).toBe('restored');
    expect(f.commands.some((command) => command.includes('--start-daemon'))).toBe(true);
    return { from: '0.4.37', to: '0.4.38', liveSessions: 0 };
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  expect(await runInstall({ cmd: 'install', what: 'daemon', version: '0.4.38' }, logger)).toBe(0);
  expect(cli.upgrade).toHaveBeenCalledWith(
    f.transport,
    expect.objectContaining({ version: '0.4.38' }),
  );
});

it('explicitly continues an existing restoration journal', async () => {
  const f = fixture();
  f.state.status = { state: 'restoring', id: f.id };
  expect(await restoreInstalledDaemon(f.transport)).toBe(true);
  expect(f.commands.find((command) => command.includes('--restore-services'))).toContain(
    `${f.id} --resume`,
  );
});

it.each(['refused', 'changed'] as const)(
  'does not start or repeat dispatch after %s restoration',
  async (outcome) => {
    const f = fixture();
    f.state.outcome = outcome;
    await expect(restoreInstalledDaemon(f.transport)).rejects.toMatchObject({
      code: 'upgrade_failed',
    });
    expect(f.commands.filter((command) => command.includes('--restore-services'))).toHaveLength(1);
    expect(f.commands.some((command) => command.includes('--start-daemon'))).toBe(false);
  },
);

it.each(['removing', 'malformed'] as const)('refuses %s status without mutation', async (kind) => {
  const f = fixture();
  f.state.status = { state: 'removing', id: f.id };
  f.state.malformed = kind === 'malformed';
  await expect(restoreInstalledDaemon(f.transport)).rejects.toMatchObject({
    code: 'upgrade_failed',
  });
  expect(f.commands.some((command) => /--restore-services|--start-daemon/.test(command))).toBe(
    false,
  );
});

it.each(['legacy', 'older', 'incompatible'] as const)(
  'does not invoke new flags on %s releases',
  async (kind) => {
    const f = fixture();
    f.state.legacy = kind === 'legacy';
    f.state.capabilities.application =
      kind === 'incompatible'
        ? { major: PROTOCOL_VERSION.major + 1, minor: 0 }
        : { major: 25, minor: 17 };
    expect(await restoreInstalledDaemon(f.transport)).toBe(false);
    f.state.active = true;
    await expect(restoreInstalledDaemon(f.transport)).rejects.toMatchObject({
      code: 'upgrade_failed',
    });
    expect(f.commands.some((command) => command.includes('host-update.mjs'))).toBe(false);
  },
);
