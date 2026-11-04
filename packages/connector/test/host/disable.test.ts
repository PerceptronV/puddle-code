import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { disableAllProfiles, requireAllProfilesDisabled } from '../../src/host/disable.js';
import { configureConnector } from '../../src/admin.js';
import { startConnectorManager } from '../../src/manager.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-removal-remote-'));
  homes.push(home);
  const config = {
    enabled: true,
    host: crypto.randomUUID(),
    account: 'fixture',
    credential: 'a'.repeat(64),
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
  };
  const directories = [
    'remote',
    'remote/profiles/' + 'a'.repeat(10),
    'remote/profiles/' + 'b'.repeat(10),
  ].map((path) => join(home, path));
  for (const directory of directories) atomicPrivateJson(join(directory, 'config.json'), config);
  const fence = () => {
    mkdirSync(join(home, 'installation/removal'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'installation/removal/services.json'), '{}', { mode: 0o600 });
  };
  return { home, config, directories, fence };
}

it('disables every saved registration while preserving credentials and permits observation during removal', async () => {
  const f = fixture();
  f.fence();
  expect(() => requireAllProfilesDisabled(f.home)).toThrow('enabled');
  await disableAllProfiles(f.home);
  requireAllProfilesDisabled(f.home);
  for (const directory of f.directories)
    expect(readPrivateJson(join(directory, 'config.json'))).toEqual({
      ...f.config,
      enabled: false,
    });
});

it('refuses connector startup and re-enablement while removal is recorded', async () => {
  const f = fixture();
  f.fence();
  await expect(startConnectorManager(f.home)).rejects.toThrow('recorded host removal');
  await expect(configureConnector(f.home, { managed: false }, 'a'.repeat(10))).rejects.toThrow(
    'recorded host removal',
  );
  expect(existsSync(join(f.directories[1]!, 'identity.json'))).toBe(false);
});

it.each(['profile', 'profiles', 'config'] as const)(
  'refuses a dangling %s link rather than treating it as absent',
  async (kind) => {
    const f = fixture();
    const target =
      kind === 'profiles'
        ? join(f.home, 'remote/profiles')
        : kind === 'profile'
          ? f.directories[1]!
          : join(f.directories[1]!, 'config.json');
    rmSync(target, { recursive: true });
    symlinkSync(join(f.home, 'absent'), target);
    expect(() => requireAllProfilesDisabled(f.home)).toThrow();
    const legacy = readFileSync(join(f.directories[0]!, 'config.json'));
    await expect(disableAllProfiles(f.home)).rejects.toThrow();
    // Inventory is validated before any profile mutation (a malformed config can
    // be discovered after another profile was already durably disabled).
    if (kind !== 'config')
      expect(readFileSync(join(f.directories[0]!, 'config.json'))).toEqual(legacy);
  },
);

it('rechecks removal after registration returns, before replacing existing registration data', async () => {
  const f = fixture();
  const profile = 'a'.repeat(10);
  const path = join(f.directories[1]!, 'config.json');
  atomicPrivateJson(path, { ...f.config, enabled: false });
  const before = readFileSync(path);
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const pending = configureConnector(
    f.home,
    { managed: false, code: 'b'.repeat(64), service: f.config.service, app: f.config.app },
    profile,
  );
  const rejected = expect(pending).rejects.toThrow('recorded host removal');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  f.fence();
  resolve(
    new Response(
      JSON.stringify({
        host: crypto.randomUUID(),
        account: 'replacement',
        credential: 'c'.repeat(64),
      }),
      { status: 200 },
    ),
  );
  await rejected;
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(join(f.directories[1]!, 'retired'))).toEqual([]);
});
