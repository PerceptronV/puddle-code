import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROTOCOL_VERSION, type HostInspection } from '@puddle/shared';
import type { Transport } from '../../src/lib/transport/transport.js';
import { upgradeDaemon } from '../../src/lib/installation/upgrade.js';
import { LocalTransport } from '../../src/lib/transport/local.js';

const mock = vi.hoisted(() => ({
  installed: vi.fn(),
  install: vi.fn(),
  inspect: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../../src/lib/installation/bootstrap.js', () => ({
  installedVersion: mock.installed,
  installDaemon: mock.install,
}));
vi.mock('../../src/lib/auth/control-channel.js', () => ({ inspectHost: mock.inspect }));
vi.mock('../../src/lib/installation/host/upgrade.js', () => ({
  upgradeHostComponent: mock.update,
}));
vi.mock('../../src/lib/installation/host/start.js', () => ({
  startInstalledDaemonForInspection: mock.start,
}));
const homes: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(protocol: { major: number; minor: number } = PROTOCOL_VERSION) {
  const inspection: HostInspection = {
    t: 'inspection',
    port: 7434,
    liveSessions: 3,
    version: { version: '0.4.0', protocol },
  };
  mock.installed.mockResolvedValue('0.4.0');
  mock.inspect.mockResolvedValue(inspection);
  mock.update.mockResolvedValue({ from: '0.4.0', to: '0.4.1' });
  mock.start.mockRejectedValue(new Error('coordinator is unavailable'));
  const exec = vi.fn(async () => ({ code: 3, stdout: '', stderr: '' }));
  // Only passive metadata inspection is allowed here; activation uses the injected coordinator.
  const transport = { kind: 'ssh', label: 'fixture-host', exec } as unknown as Transport;
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { transport, exec, logger };
}

it('routes ordinary daemon upgrades to the shared host transaction and keeps live sessions distinct from interruptions', async () => {
  const f = fixture();
  const confirmInterruption = vi.fn(async () => true);
  expect(
    await upgradeDaemon(f.transport, { version: '0.4.1', logger: f.logger, confirmInterruption }),
  ).toEqual({ from: '0.4.0', to: '0.4.1', liveSessions: 3 });
  expect(mock.update).toHaveBeenCalledExactlyOnceWith(f.transport, 'daemon', {
    version: '0.4.1',
    logger: f.logger,
    confirmInterruption,
  });
  expect(mock.install).not.toHaveBeenCalled();
  expect(f.logger.info).not.toHaveBeenCalled();
});

it('never falls back to bootstrap after an uncertain coordinator action or failed host inspection', async () => {
  const f = fixture();
  mock.update.mockRejectedValueOnce(new Error('Reply lost'));
  await expect(upgradeDaemon(f.transport)).rejects.toThrow('Reply lost');
  mock.inspect.mockRejectedValueOnce(new Error('Inspection failed'));
  await expect(upgradeDaemon(f.transport)).rejects.toThrow('Inspection failed');
  expect(mock.install).not.toHaveBeenCalled();
  expect(mock.update).toHaveBeenCalledOnce();
});

it('refuses a disconnected modern installation instead of bypassing its update records', async () => {
  const f = fixture();
  mock.inspect.mockResolvedValueOnce(null);
  f.exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
  await expect(upgradeDaemon(f.transport)).rejects.toThrow('coordinator is unavailable');
  expect(mock.install).not.toHaveBeenCalled();
  expect(mock.update).not.toHaveBeenCalled();
  expect(mock.start).toHaveBeenCalledOnce();
});

it('starts the selected stopped daemon before staging an explicitly requested update', async () => {
  const f = fixture();
  mock.inspect.mockResolvedValueOnce(null);
  mock.start.mockResolvedValueOnce({
    t: 'inspection',
    port: 7434,
    liveSessions: 3,
    version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
  });
  f.exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
  const result = await upgradeDaemon(f.transport, { version: '0.4.1' });
  expect(result.to).toBe('0.4.1');
  expect(mock.start).toHaveBeenCalledExactlyOnceWith(f.transport);
  expect(mock.update).toHaveBeenCalledExactlyOnceWith(f.transport, 'daemon', { version: '0.4.1' });
  expect(mock.install).not.toHaveBeenCalled();
});

it('retains the embedded installer and interruption message for a legacy transition', async () => {
  const f = fixture({ major: 25, minor: 6 });
  await upgradeDaemon(f.transport, { version: '0.4.1', logger: f.logger });
  expect(mock.install).toHaveBeenCalledOnce();
  expect(mock.update).not.toHaveBeenCalled();
  expect(f.logger.info).toHaveBeenCalledWith(
    '3 live session(s) will be interrupted and can be resumed',
  );
});

it('bootstraps a fresh SSH target when no installed Node can run the inspection helper', async () => {
  const f = fixture();
  mock.installed.mockResolvedValueOnce(null);
  mock.inspect.mockRejectedValueOnce(new Error('Could not stage the host control helper'));
  const result = await upgradeDaemon(f.transport, { version: '0.4.1' });
  expect(result.from).toBeNull();
  expect(mock.install).toHaveBeenCalledOnce();
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.update).not.toHaveBeenCalled();
});

it.each([
  'bin/current/HOST_CAPABILITIES.json',
  'bin/runtime-current',
  'updates/operations.json',
  'runtime-controller.json',
  'runtimes',
])('preserves modern host evidence at %s when its daemon cannot connect', async (path) => {
  fixture();
  const home = mkdtempSync(join(tmpdir(), 'puddle-upgrade-marker-'));
  homes.push(home);
  vi.stubEnv('PUDDLE_HOME', home);
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  if (path === 'bin/runtime-current') symlinkSync('missing-generation', file);
  else writeFileSync(file, '{}');
  mock.inspect.mockResolvedValueOnce(null);
  const transport = new LocalTransport();
  try {
    await expect(upgradeDaemon(transport)).rejects.toThrow('coordinator is unavailable');
    expect(mock.install).not.toHaveBeenCalled();
  } finally {
    transport.dispose();
  }
});

it('pins trusted older-major inspection to the private update-only connection and forwards exact consent', async () => {
  const f = fixture({ major: 25, minor: 20 });
  const confirmInterruption = vi.fn(async () => true);
  await upgradeDaemon(f.transport, { version: '0.4.1', confirmInterruption });
  expect(mock.update).toHaveBeenCalledExactlyOnceWith(f.transport, 'daemon', {
    version: '0.4.1',
    confirmInterruption,
    outgoing: { version: '0.4.0', protocol: { major: 25, minor: 20 } },
  });
  expect(mock.install).not.toHaveBeenCalled();
});

it('starts an older-major selected daemon through inspection before opening scoped update authority', async () => {
  const f = fixture({ major: 25, minor: 20 });
  mock.inspect.mockResolvedValueOnce(null);
  mock.start.mockResolvedValueOnce({
    t: 'inspection',
    port: 7434,
    liveSessions: 3,
    version: { version: '0.4.0', protocol: { major: 25, minor: 20 } },
  });
  f.exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
  await upgradeDaemon(f.transport, { version: '0.4.1' });
  expect(mock.start).toHaveBeenCalledOnce();
  expect(mock.update).toHaveBeenCalledExactlyOnceWith(f.transport, 'daemon', {
    version: '0.4.1',
    outgoing: { version: '0.4.0', protocol: { major: 25, minor: 20 } },
  });
  expect(mock.install).not.toHaveBeenCalled();
});
