import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleVersionAtLeast } from '../../src/agents/lifecycle-version.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('uses the launch PATH and does not reuse a service-environment failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-env-'));
  directories.push(directory);
  writeFileSync(join(directory, 'fixture-agent'), '#!/bin/sh\nprintf "agent 1.2.3\\n"\n', {
    mode: 0o700,
  });
  vi.stubEnv('PATH', '/usr/bin:/bin');
  await expect(lifecycleVersionAtLeast('fixture-agent', ['--version'], [1, 2, 3])).resolves.toBe(
    false,
  );
  await expect(
    lifecycleVersionAtLeast('fixture-agent', ['--version'], [1, 2, 3], { PATH: directory }),
  ).resolves.toBe(true);
  expect(process.env.PATH).toBe('/usr/bin:/bin');
});

it('shares one version observation across capability floors and expires after CLI replacement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-cache-'));
  directories.push(directory);
  const binary = join(directory, 'fixture-agent');
  const count = join(directory, 'calls');
  const install = (version: string) =>
    writeFileSync(binary, `#!/bin/sh\nprintf x >> '${count}'\nprintf 'agent ${version}\\n'\n`, {
      mode: 0o700,
    });
  install('1.2.3');
  expect(
    await Promise.all([
      lifecycleVersionAtLeast(binary, ['--version'], [1, 0, 0]),
      lifecycleVersionAtLeast(binary, ['--version'], [2, 0, 0], undefined, true),
      lifecycleVersionAtLeast(binary, ['--version'], [1, 2, 3]),
    ]),
  ).toEqual([true, false, true]);
  expect(readFileSync(count, 'utf8')).toBe('x');
  install('2.0.0');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30_001);
  try {
    expect(await lifecycleVersionAtLeast(binary, ['--version'], [2, 0, 0])).toBe(true);
    expect(readFileSync(count, 'utf8')).toBe('xx');
  } finally {
    clock.mockRestore();
  }
});

it('keeps mandatory ownership checks strict when an optional check already failed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-missing-'));
  directories.push(directory);
  const binary = join(directory, 'missing');
  expect(await lifecycleVersionAtLeast(binary, ['--version'], [1, 0, 0])).toBe(false);
  await expect(
    lifecycleVersionAtLeast(binary, ['--version'], [2, 0, 0], undefined, true),
  ).rejects.toThrow('Cannot verify');
});

it('reuses a private observation across owners but invalidates executable and environment changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-owners-'));
  directories.push(directory);
  const binary = join(directory, 'fixture-agent');
  const count = join(directory, 'calls');
  const install = (version: string) =>
    writeFileSync(binary, `#!/bin/sh\nprintf x >> '${count}'\nprintf 'agent ${version}\\n'\n`, {
      mode: 0o700,
    });
  install('1.2.3');
  const probe = async (env: Record<string, string>, required = false) => {
    vi.resetModules(); // Independent runtimes have no shared JavaScript cache.
    const { lifecycleVersionAtLeast: check } =
      await import('../../src/agents/lifecycle-version.js');
    return check(binary, ['--version'], [1, 2, 3], env, required, directory);
  };
  expect(await probe({ PUDDLE_AGENT_HELPER_DIR: '/owner/one' })).toBe(true);
  expect(await probe({ PUDDLE_AGENT_HELPER_DIR: '/owner/two' })).toBe(true);
  expect(readFileSync(count, 'utf8')).toBe('x');
  expect(await probe({ PUDDLE_AGENT_HELPER_DIR: '/owner/three' }, true)).toBe(true);
  expect(readFileSync(count, 'utf8')).toBe('xx');
  install('0.9.0');
  expect(await probe({ PUDDLE_AGENT_HELPER_DIR: '/owner/four' })).toBe(false);
  expect(readFileSync(count, 'utf8')).toBe('xxx');
  expect(await probe({ GEMINI_CLI_HOME: '/another-account' })).toBe(false);
  expect(readFileSync(count, 'utf8')).toBe('xxxx');
});

it('does not renew a cached observation lifetime and ignores invalid stored observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-expiry-'));
  directories.push(directory);
  const binary = join(directory, 'fixture-agent');
  const count = join(directory, 'calls');
  writeFileSync(binary, `#!/bin/sh\nprintf x >> '${count}'\nprintf 'agent 1.2.3\\n'\n`, {
    mode: 0o700,
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const probe = async () => {
    vi.resetModules();
    const { lifecycleVersionAtLeast: check } =
      await import('../../src/agents/lifecycle-version.js');
    return check(binary, ['--version'], [1, 2, 3], undefined, false, directory);
  };
  try {
    expect(await probe()).toBe(true);
    clock.mockReturnValue(now + 29_000);
    expect(await probe()).toBe(true);
    clock.mockReturnValue(now + 30_001);
    expect(await probe()).toBe(true);
    expect(readFileSync(count, 'utf8')).toBe('xx');
    writeFileSync(join(directory, '.puddle-cli-version.json'), 'x'.repeat(5000));
    expect(await probe()).toBe(true);
    expect(readFileSync(count, 'utf8')).toBe('xxx');
  } finally {
    clock.mockRestore();
  }
});
