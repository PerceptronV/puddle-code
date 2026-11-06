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
